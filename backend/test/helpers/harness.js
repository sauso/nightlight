// Shared test harness.
//
// Everything here exists to make the backend testable WITHOUT its process tree: no FFmpeg, no MediaMTX,
// no camera, no network. Two things make that possible:
//
//   1. `DATA_DIR` is read from the environment at module load, so pointing it at a temp directory before
//      importing anything gives each suite its own throwaway SQLite file (created from scratch by
//      db.js's `CREATE TABLE IF NOT EXISTS`). Nothing is mocked — it's the real schema and real queries.
//   2. Routers are plain Express routers mounted in index.js, so a test can mount ONE on a bare app and
//      exercise it over real HTTP without booting the app that spawns child processes.
//
// Because DATA_DIR must be set before the first import of db.js, callers use `await bootstrap()` and
// then the dynamic imports it returns — a static `import` would be hoisted and run too early.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// bcryptjs and jsonwebtoken are CommonJS; createRequire loads them from an ES module without making
// every fixture helper async.
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const dirs = [];

// Point DATA_DIR at a fresh temp dir and load the modules that depend on it. Call once per suite,
// before importing anything from src/.
export function useTempDataDir({ jwtSecret = 'test-secret-not-used-anywhere-real' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-'));
  dirs.push(dir);
  process.env.DATA_DIR = dir;
  // A fixed secret keeps signed tokens reproducible and skips the random-secret file write. Pass
  // `{ jwtSecret: null }` to leave it unset and exercise the generate-and-persist bootstrap instead.
  if (jwtSecret) process.env.JWT_SECRET = jwtSecret;
  else delete process.env.JWT_SECRET;
  return dir;
}

// Remove every temp dir this process created. Safe to call more than once.
export function cleanupTempDataDirs() {
  while (dirs.length) {
    const d = dirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// --- fixtures ---------------------------------------------------------------------------------
// Small builders so a test says what matters to it and inherits sane defaults for the rest.

export function makeUser(db, { id = 'u-admin', username = 'admin', role = 'admin', password = 'hunter22' } = {}) {
  // Hashing for real (not a stub) keeps the login path honest.
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run(id, username, bcrypt.hashSync(password, 8), role);
  return { id, username, role, password };
}

export function makeSession(db, userId, { id = crypto.randomUUID() } = {}) {
  db.prepare(`INSERT INTO sessions (id, user_id, user_agent) VALUES (?, ?, 'test')`).run(id, userId);
  return id;
}

export function makeChild(db, { id = 'c-1', name = 'Test Child', track = 1, start = '19:30', end = '07:00' } = {}) {
  db.prepare(
    `INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, track, start, end);
  return { id, name };
}

export function makeCamera(db, { id = 'cam-1', name = 'Test Cam', childId = null, path: mp = null, extra = {} } = {}) {
  db.prepare(
    `INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, 'rtsp://user:pass@example/stream', childId, mp || `path_${id}`);
  for (const [col, val] of Object.entries(extra)) {
    db.prepare(`UPDATE cameras SET ${col} = ? WHERE id = ?`).run(val, id);
  }
  return { id, name };
}

// --- HTTP -------------------------------------------------------------------------------------

// Mount one router on a bare Express app and start it on an ephemeral port. Returns { url, close }.
// Deliberately NOT the real index.js app: that one spawns MediaMTX and a transcoder per camera.
// Same as mountRouter, but with `trust proxy` on so a test can claim its own source address via
// X-Forwarded-For. Needed to prove a rate-limit key includes the CLIENT IP: a harness where every
// request arrives from 127.0.0.1 cannot tell "keyed by IP+username" from "keyed by username alone",
// and that gap let a targeted-lockout mutant survive (issue #248).
export async function mountRouterTrustingProxy(mountPath, router) {
  const { default: express } = await import("express");
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const sv = app.listen(0, "127.0.0.1", () => resolve(sv)); });
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function mountRouter(mountPath, router) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  // Mirror the app's own JSON error shape so tests assert against what clients really see.
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// A signed session token for `user`, matching what routes/auth.js issues.
export function signToken(payload, { expiresIn = '30d' } = {}) {
  return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn });
}

// fetch with the Authorization header attached, returning { status, body } with the body already
// parsed when it's JSON (routes return JSON for everything except file streams).
export async function call(url, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON (a file) — leave as text */ }
  return { status: res.status, body: parsed };
}
