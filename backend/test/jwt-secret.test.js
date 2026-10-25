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
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const DATA_DIR = useTempDataDir({ jwtSecret: null });
// #553 phase 2a: a fresh install keeps it in private/ (0700), next to the database.
const SECRET_FILE = path.join(DATA_DIR, 'private', '.jwt_secret');

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
  assert.equal(fs.existsSync(path.join(dir, 'private', '.jwt_secret')), false, 'an explicit secret needs no file');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- #553 phase 2a: where the file is ---------------------------------------------------------------------------
const boot = (dir) => execFileSync(
  process.execPath,
  ['-e', "import('./src/middleware/auth.js').then(m => console.log('SECRET=' + m.JWT_SECRET))"],
  { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, JWT_SECRET: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
);
const secretOf = (out) => /^SECRET=(.*)$/m.exec(out)?.[1];

test('#553 a fresh install writes it into private/, and private/ is 0700 (Linux) whatever the umask', () => {
  assert.ok(fs.existsSync(SECRET_FILE), 'not in private/');
  assert.equal(fs.existsSync(path.join(DATA_DIR, '.jwt_secret')), false, 'also written at the top level');
  if (process.platform === 'linux') {
    assert.equal((fs.statSync(path.join(DATA_DIR, 'private')).mode & 0o777).toString(8), '700');
    assert.equal((fs.statSync(SECRET_FILE).mode & 0o777).toString(8), '600');
  }
});

test('#553 an install the move has not reached yet keeps using its top-level .jwt_secret (nobody is signed out)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-legacy-'));
  fs.writeFileSync(path.join(dir, '.jwt_secret'), 'the-old-secret\n');
  assert.equal(secretOf(boot(dir)), 'the-old-secret');
  assert.equal(fs.existsSync(path.join(dir, 'private', '.jwt_secret')), false, 'a second secret was made in private/');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#553 an install not moved yet that has NO secret: a new one goes into private/, which auth.js creates (0700) first', () => {
  // db.js opens the top-level database and makes no private/, so the folder is auth.js's to make: writeFileSync does
  // not create folders, and this write used to fail silently (plan review C9).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-newsecret-'));
  new Database(path.join(dir, 'babymonitor.db')).close();
  const secret = secretOf(boot(dir));
  assert.ok(secret, 'no secret');
  assert.equal(fs.readFileSync(path.join(dir, 'private', '.jwt_secret'), 'utf8'), secret, 'not persisted in private/');
  if (process.platform === 'linux') assert.equal((fs.statSync(path.join(dir, 'private')).mode & 0o777).toString(8), '700');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#553 with one in private/ AND one at the top level, the private one is used', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-both-'));
  fs.mkdirSync(path.join(dir, 'private'));
  fs.writeFileSync(path.join(dir, 'private', '.jwt_secret'), 'private-one');
  fs.writeFileSync(path.join(dir, '.jwt_secret'), 'top-one');
  assert.equal(secretOf(boot(dir)), 'private-one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#553 a secret that cannot be saved is said LOUDLY (it used to fail silently, signing everyone out at every restart)', () => {
  // An install the move has not reached (its database at the top level, so db.js opens it there), with a FILE called
  // "private" where the folder must be: a new secret, which goes into private/, cannot be written.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-jwt-fail-'));
  new Database(path.join(dir, 'babymonitor.db')).close();
  fs.writeFileSync(path.join(dir, 'private'), 'not a folder');
  const r = spawnSync(
    process.execPath,
    ['-e', "import('./src/middleware/auth.js').then(m => console.log('SECRET=' + m.JWT_SECRET))"],
    { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, JWT_SECRET: '' }, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(secretOf(r.stdout), 'the app still got a secret for this run');
  assert.match(r.stderr, /\[auth\] could not save the session signing secret to .*private.*\.jwt_secret .*everyone will be signed out at every restart/);
  fs.rmSync(dir, { recursive: true, force: true });
});
