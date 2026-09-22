// Public-demo boundary tests. These use the real router, SQLite schema, JWT/session middleware and
// rate-limit stores: a mocked login would miss the two failures that matter here — minting the wrong
// identity, or counting 31-day session rows instead of guests who are active now.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  call, cleanupTempDataDirs, makeUser, useTempDataDir,
} from './helpers/harness.js';

const dataDir = useTempDataDir();
delete process.env.DEMO_MODE;

const { default: db } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/routes/auth.js');
const { requireAuth } = await import('../src/middleware/auth.js');
const { demoGuard, demoRequestLimiter } = await import('../src/middleware/demoMode.js');
const { motionLegWanted } = await import('../src/lib/motionDetector.js');
const { default: express } = await import('express');

let server;
let url;

before(async () => {
  const app = express();
  // One explicit trusted hop lets fixtures claim distinct clients without the unsafe trust-proxy=true
  // configuration that express-rate-limit rightly warns about.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(demoRequestLimiter);
  app.use(demoGuard);
  app.use('/api/auth', authRoutes);
  app.get('/api/probe', requireAuth, (req, res) => res.json({ username: req.user.username }));
  app.put('/api/probe', requireAuth, (_req, res) => res.json({ changed: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  cleanupTempDataDirs();
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_ENDS_AT;
  delete process.env.DEMO_LOBBY_URL;
  delete process.env.DEMO_MAX_GUESTS;
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  fs.rmSync(path.join(dataDir, '.demo-ready'), { force: true });
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_ENDS_AT;
  delete process.env.DEMO_LOBBY_URL;
  process.env.DEMO_MAX_GUESTS = '25';
});

function seedGuest() {
  return makeUser(db, { id: 'u-demo', username: 'demo-guest', role: 'admin', password: 'unusable-random-value' });
}

function from(ip, requestPath, options = {}) {
  return call(`${url}${requestPath}`, {
    ...options,
    headers: { 'x-forwarded-for': ip, ...options.headers },
  });
}

describe('POST /api/auth/guest', () => {
  test('is a plain 404 unless DEMO_MODE is exactly true', async () => {
    seedGuest();
    for (const [i, value] of [undefined, 'false', 'TRUE', '1'].entries()) {
      if (value === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = value;
      const res = await from(`198.51.100.${i + 1}`, '/api/auth/guest', { method: 'POST' });
      assert.equal(res.status, 404, `DEMO_MODE=${String(value)} exposed the guest endpoint`);
    }
  });

  test('ignores the body and mints only the fixed admin guest identity', async () => {
    process.env.DEMO_MODE = 'true';
    seedGuest();
    makeUser(db, { id: 'u-other', username: 'body-selected', role: 'caregiver' });

    const res = await from('198.51.100.10', '/api/auth/guest', {
      method: 'POST',
      body: { username: 'body-selected', role: 'caregiver' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'demo-guest');
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.mfa_enabled, false);
    assert.ok(res.body.token);
  });

  test('returns 404 rather than inventing a fallback identity when the seeded guest is absent', async () => {
    process.env.DEMO_MODE = 'true';
    makeUser(db, { id: 'u-other', username: 'someone-else', role: 'admin' });
    const res = await from('198.51.100.11', '/api/auth/guest', { method: 'POST' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not available/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  });

  test('the guest token reads normally, while writes and first-run setup remain blocked', async () => {
    process.env.DEMO_MODE = 'true';
    seedGuest();
    const signedIn = await from('198.51.100.12', '/api/auth/guest', { method: 'POST' });

    const read = await from('198.51.100.12', '/api/probe', { token: signedIn.body.token });
    assert.equal(read.status, 200);
    assert.equal(read.body.username, 'demo-guest');

    const write = await from('198.51.100.12', '/api/probe', {
      method: 'PUT', token: signedIn.body.token, body: { changed: true },
    });
    assert.equal(write.status, 403);
    assert.match(write.body.error, /read-only public demo/);

    const setup = await from('198.51.100.12', '/api/auth/setup', {
      method: 'POST', body: { username: 'owner', password: 'password1' },
    });
    assert.equal(setup.status, 403);
  });

  test('admits 25 active guests, refuses the 26th, and logout frees a slot', async () => {
    process.env.DEMO_MODE = 'true';
    seedGuest();
    const admitted = [];
    for (let i = 1; i <= 25; i += 1) {
      const res = await from(`203.0.113.${i}`, '/api/auth/guest', { method: 'POST' });
      assert.equal(res.status, 200, `guest ${i} should be admitted`);
      admitted.push(res.body.token);
    }

    const full = await from('203.0.113.26', '/api/auth/guest', { method: 'POST' });
    assert.equal(full.status, 429);
    assert.match(full.body.error, /demo is full/i);

    const logout = await from('203.0.113.1', '/api/auth/logout', {
      method: 'POST', token: admitted[0], body: {},
    });
    assert.equal(logout.status, 204);
    const replacement = await from('203.0.113.27', '/api/auth/guest', { method: 'POST' });
    assert.equal(replacement.status, 200);
  });

  test('counts activity in the last two minutes, not every retained session row', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_MAX_GUESTS = '1';
    const guest = seedGuest();
    // 2m30s is the discriminating fixture: stale under the v2 two-minute contract, but still active
    // under the superseded three-minute review draft.
    db.prepare(
      "INSERT INTO sessions (id, user_id, last_seen_at) VALUES ('stale', ?, datetime('now', '-150 seconds'))"
    ).run(guest.id);

    const admitted = await from('198.51.100.20', '/api/auth/guest', { method: 'POST' });
    assert.equal(admitted.status, 200);
    const full = await from('198.51.100.21', '/api/auth/guest', { method: 'POST' });
    assert.equal(full.status, 429);
  });

  test('has its own per-IP sign-in budget', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_MAX_GUESTS = '100';
    seedGuest();
    for (let i = 1; i <= 20; i += 1) {
      const res = await from('198.51.100.30', '/api/auth/guest', { method: 'POST' });
      assert.equal(res.status, 200, `sign-in ${i} should remain inside the budget`);
    }
    const blocked = await from('198.51.100.30', '/api/auth/guest', { method: 'POST' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /too many demo sign-ins/i);
  });
});

describe('GET /api/auth/status', () => {
  test('adds the demo contract, optional lobby URL, and reads readiness live', async () => {
    const normal = await from('198.51.100.40', '/api/auth/status');
    assert.equal(normal.status, 200);
    assert.equal(normal.body.demo, false);
    assert.equal(normal.body.needsSetup, true);

    process.env.DEMO_MODE = 'true';
    process.env.DEMO_ENDS_AT = '2026-09-21T10:20:00.000Z';
    const starting = await from('198.51.100.40', '/api/auth/status');
    assert.deepEqual(starting.body.demo, {
      endsAt: '2026-09-21T10:20:00.000Z', lobbyUrl: null, ready: false, full: false,
    });

    process.env.DEMO_LOBBY_URL = 'https://lobby.example.test/start';
    fs.writeFileSync(path.join(dataDir, '.demo-ready'), 'ready\n');
    const ready = await from('198.51.100.40', '/api/auth/status');
    assert.deepEqual(ready.body.demo, {
      endsAt: '2026-09-21T10:20:00.000Z',
      lobbyUrl: 'https://lobby.example.test/start',
      ready: true,
      full: false,
    });
  });

  test('reports full at 25 active guests, not at 24 or because of a stale session', async () => {
    process.env.DEMO_MODE = 'true';
    const guest = seedGuest();
    for (let index = 0; index < 24; index += 1) {
      db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(`active-${index}`, guest.id);
    }
    db.prepare(
      "INSERT INTO sessions (id, user_id, last_seen_at) VALUES ('stale-status', ?, datetime('now', '-150 seconds'))"
    ).run(guest.id);

    const available = await from('198.51.100.41', '/api/auth/status');
    assert.equal(available.body.demo.full, false, '24 active guests plus one stale guest was reported full');

    db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run('active-24', guest.id);
    const full = await from('198.51.100.41', '/api/auth/status');
    assert.equal(full.body.demo.full, true, 'the 25th active guest did not fill the demo');
  });
});

test('the demo guest sentinel cannot be used for password login', async () => {
  process.env.DEMO_MODE = 'true';
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES ('u-demo', 'demo-guest', '!', 'admin')"
  ).run();
  const stored = db.prepare("SELECT password_hash FROM users WHERE username = 'demo-guest'").get().password_hash;
  assert.doesNotMatch(stored, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);

  const response = await from('198.51.100.42', '/api/auth/login', {
    method: 'POST', body: { username: 'demo-guest', password: 'anything' },
  });
  assert.equal(response.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
});

describe('demo-wide request limiting', () => {
  test('caps one demo IP across reads, but is a complete no-op when demo mode is off', async () => {
    process.env.DEMO_MODE = 'true';
    let inside;
    for (let i = 0; i < 600; i += 1) {
      inside = await from('198.51.100.50', '/api/probe');
    }
    assert.equal(inside.status, 401, 'the 600th request should still reach authentication');
    const blocked = await from('198.51.100.50', '/api/probe');
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /too many demo requests/i);

    delete process.env.DEMO_MODE;
    const normalInstall = await from('198.51.100.50', '/api/probe');
    assert.equal(normalInstall.status, 401, 'a normal install inherited the exhausted demo bucket');
  });
});

test('motionLegWanted disables every live pixel-diff leg only in demo mode', () => {
  const alertingCamera = { disabled: 0, detect_motion_enabled: 1, detect_source: 'framediff' };
  delete process.env.DEMO_MODE;
  assert.equal(motionLegWanted(alertingCamera), true);
  process.env.DEMO_MODE = 'TRUE';
  assert.equal(motionLegWanted(alertingCamera), true, 'misspelled demo mode must not alter a normal install');
  process.env.DEMO_MODE = 'true';
  assert.equal(motionLegWanted(alertingCamera), false);
});

