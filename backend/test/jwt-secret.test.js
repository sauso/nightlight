// The JWT signing-secret bootstrap.
//
// Worth its own suite because it is a security safeguard, not a convenience: this image is publicly
// distributed, so a hardcoded fallback secret would mean every default install shares one publicly-known
// signing key — anyone could mint a valid token for anyone else's monitor. Instead a random secret is
// generated on first run and persisted in the data volume so sessions survive a restart.
//
// It needs its own file because it can only be exercised with JWT_SECRET UNSET, and the middleware
// resolves the secret once at module load.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const DATA_DIR = useTempDataDir({ jwtSecret: null });
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

const { JWT_SECRET } = await import('../src/middleware/auth.js');

after(() => cleanupTempDataDirs());

test('a secret is generated when JWT_SECRET is not set', () => {
  assert.ok(JWT_SECRET, 'a secret must exist');
  assert.ok(JWT_SECRET.length >= 64, 'should be long enough to be a real key, not a placeholder');
  assert.match(JWT_SECRET, /^[0-9a-f]+$/, 'hex-encoded random bytes');
});

test('the generated secret is persisted so sessions survive a restart', () => {
  // Without persistence every container restart would silently sign everyone out.
  assert.ok(fs.existsSync(SECRET_FILE), 'the secret file should have been written');
  assert.equal(fs.readFileSync(SECRET_FILE, 'utf8').trim(), JWT_SECRET);
});

test('★ the secret is NOT a hardcoded constant — a second install gets a different one', () => {
  // The actual security property. Re-run the bootstrap against a fresh data dir in a child process
  // (the module caches its secret, so it can't be re-evaluated in-process) and require a different key.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-'));
  const out = execFileSync(
    process.execPath,
    ['-e', "import('./src/middleware/auth.js').then(m => console.log(m.JWT_SECRET))"],
    { cwd: process.cwd(), env: { ...process.env, DATA_DIR: other, JWT_SECRET: '' }, encoding: 'utf8' }
  ).trim();
  assert.ok(out, 'child process should report a secret');
  assert.notEqual(out, JWT_SECRET, 'two independent installs must not share a signing key');
  fs.rmSync(other, { recursive: true, force: true });
});

test('an existing secret file is reused rather than regenerated', () => {
  // Second boot in the same data dir must return the SAME key, or every restart invalidates sessions.
  const read = (dir) => execFileSync(
    process.execPath,
    ['-e', "import('./src/middleware/auth.js').then(m => console.log(m.JWT_SECRET))"],
    { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, JWT_SECRET: '' }, encoding: 'utf8' }
  ).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-reuse-'));
  const first = read(dir);
  const second = read(dir);
  assert.equal(second, first, 'the persisted secret should be reused on the next boot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicit JWT_SECRET env var wins and nothing is written to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-env-'));
  const out = execFileSync(
    process.execPath,
    ['-e', "import('./src/middleware/auth.js').then(m => console.log(m.JWT_SECRET))"],
    { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, JWT_SECRET: 'operator-supplied-secret' }, encoding: 'utf8' }
  ).trim();
  assert.equal(out, 'operator-supplied-secret');
  assert.equal(fs.existsSync(path.join(dir, '.jwt_secret')), false, 'an explicit secret needs no file');
  fs.rmSync(dir, { recursive: true, force: true });
});
