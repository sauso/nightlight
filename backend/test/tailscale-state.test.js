import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareStateDir, makeRuntimeDir, removeRuntimeDir } from '../src/lib/tailscaleState.js';

const roots = [];
const root = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-ts-state-')); roots.push(p); return p; };
const uid = process.getuid?.() || 1500;
// On Windows the filesystem does not report POSIX ownership; override only that field so
// the guard's other lstat checks still inspect real files (Opus plan review of #965).
const ownedFs = { ...fs, lstatSync: (p) => {
  const st = fs.lstatSync(p);
  return process.platform === 'win32' ? Object.assign(st, { uid, mode: (st.mode & ~0o777) | (st.isDirectory() ? 0o700 : 0o600) }) : st;
} };
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

test('#965 state refuses root and an owner mismatch', () => {
  const dataDir = root();
  const rootOwned = { ...ownedFs, lstatSync: (p) => Object.assign(ownedFs.lstatSync(p), { uid: 0 }) };
  assert.equal(prepareStateDir({ dataDir, uid: 0, fsImpl: rootOwned }).ok, false);
  const mismatch = { ...ownedFs, lstatSync: (p) => Object.assign(fs.lstatSync(p), { uid: uid + 1 }) };
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: mismatch }).reason, 'state_owner_mismatch');
});

test('#965 state refuses symlink, non-directory, and chmod EPERM', (t) => {
  const dataDir = root();
  fs.writeFileSync(path.join(dataDir, 'private'), 'x');
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: ownedFs }).ok, false);
  fs.rmSync(path.join(dataDir, 'private'));
  if (process.platform === 'win32') t.diagnostic('symlink creation requires Windows developer mode; Linux CI tests the link');
  else {
    fs.symlinkSync(root(), path.join(dataDir, 'private'), 'dir');
    assert.equal(prepareStateDir({ dataDir, uid, fsImpl: ownedFs }).ok, false);
    fs.rmSync(path.join(dataDir, 'private'));
  }
  const denied = { ...ownedFs, chmodSync: () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; } };
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: denied }).reason, 'state_unwritable');
});

test('#965 state refuses a chmod-ignoring share and unwritable directory', () => {
  const dataDir = root();
  const ignores = { ...ownedFs, lstatSync: (p) => {
    const st = ownedFs.lstatSync(p);
    return Object.assign(st, { mode: (st.mode & ~0o777) | 0o755 });
  } };
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: ignores }).reason, 'state_mode_unverifiable');
  const unwritable = { ...ownedFs, accessSync: () => { throw new Error('read-only share'); } };
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: unwritable }).reason, 'state_unwritable');
});

test('#965 a share that ignores state-file chmod is refused', () => {
  const dataDir = root();
  const stateDir = path.join(dataDir, 'private', 'tailscale');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'tailscaled.state');
  fs.writeFileSync(stateFile, 'state');
  const ignores = { ...ownedFs, lstatSync: (p) => {
    const st = ownedFs.lstatSync(p);
    return p === stateFile ? Object.assign(st, { mode: (st.mode & ~0o777) | 0o644 }) : st;
  } };
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: ignores }).reason, 'state_mode_unverifiable');
});

test('#965 state and runtime are private and a 0644 state file is tightened', {
  skip: process.platform === 'win32' && 'POSIX modes are not enforced on win32; Linux CI runs this',
}, () => {
  const dataDir = root();
  const first = prepareStateDir({ dataDir, uid, fsImpl: ownedFs });
  assert.equal(first.ok, true, first.reason);
  const file = path.join(first.stateDir, 'tailscaled.state');
  fs.writeFileSync(file, 'state', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.equal(prepareStateDir({ dataDir, uid, fsImpl: ownedFs }).ok, true);
  assert.equal(fs.statSync(first.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const runtime = makeRuntimeDir({ uid, fsImpl: ownedFs });
  assert.equal(runtime.ok, true, runtime.reason);
  assert.equal(fs.statSync(runtime.runtimeDir).mode & 0o777, 0o700);
  assert.equal(runtime.socketPath.startsWith(dataDir), false);
  removeRuntimeDir(runtime.runtimeDir);
  assert.equal(fs.existsSync(runtime.runtimeDir), false);
});

test('#965 runtime path refuses a Unix socket path longer than 107 bytes', () => {
  const tmpDir = path.join(root(), 'x'.repeat(100));
  fs.mkdirSync(tmpDir);
  const r = makeRuntimeDir({ uid, fsImpl: ownedFs, tmpDir });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'socket_path_too_long');
});

test('#965 runtime directories use unpredictable distinct names', () => {
  const tmpDir = root();
  const a = makeRuntimeDir({ uid, fsImpl: ownedFs, tmpDir });
  const b = makeRuntimeDir({ uid, fsImpl: ownedFs, tmpDir });
  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  assert.notEqual(a.runtimeDir, b.runtimeDir);
  removeRuntimeDir(a.runtimeDir);
  removeRuntimeDir(b.runtimeDir);
});
