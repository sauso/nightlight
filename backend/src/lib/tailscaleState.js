import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SOCKET_NAME = 'tailscaled.sock';

function verifyDir(dir, uid, fsImpl) {
  const st = fsImpl.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a real directory`);
  if (st.uid !== uid) throw new Error(`${dir} has the wrong owner`);
  if ((st.mode & 0o777) !== DIR_MODE) throw new Error(`${dir} did not retain mode 0700`);
  fsImpl.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function tightenEntries(dir, uid, fsImpl) {
  for (const name of fsImpl.readdirSync(dir)) {
    const entry = path.join(dir, name);
    const st = fsImpl.lstatSync(entry);
    if (st.isSymbolicLink() || st.uid !== uid) throw new Error(`${entry} is not app-owned or is a symlink`);
    if (st.isDirectory()) {
      fsImpl.chmodSync(entry, DIR_MODE);
      verifyDir(entry, uid, fsImpl);
      tightenEntries(entry, uid, fsImpl);
    } else if (st.isFile()) {
      fsImpl.chmodSync(entry, FILE_MODE);
      if ((fsImpl.lstatSync(entry).mode & 0o777) !== FILE_MODE) throw new Error(`${entry} did not retain mode 0600`);
    } else throw new Error(`${entry} is not a regular state file`);
  }
}

// Opus plan review of #965: data shares can ignore chmod, and ensurePrivateDir permits symlinks.
// The daemon's state needs stricter checks, including a post-chmod lstat of the actual object.
export function prepareStateDir({ dataDir, uid = process.getuid?.(), fsImpl = fs } = {}) {
  try {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Tailscale requires a non-root app uid');
    if (!dataDir) throw new Error('data directory is required');
    const privateDir = path.join(dataDir, 'private');
    const stateDir = path.join(privateDir, 'tailscale');
    for (const dir of [privateDir, stateDir]) {
      try { fsImpl.mkdirSync(dir, { mode: DIR_MODE }); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
      const initial = fsImpl.lstatSync(dir);
      if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error(`${dir} is not a real directory`);
      if (initial.uid !== uid) throw new Error(`${dir} has the wrong owner`);
      fsImpl.chmodSync(dir, DIR_MODE);
      verifyDir(dir, uid, fsImpl);
    }
    // --statedir can contain certificate subdirectories as well as the state file.
    tightenEntries(stateDir, uid, fsImpl);
    return { ok: true, stateDir };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function makeRuntimeDir({ uid = process.getuid?.(), fsImpl = fs, tmpDir = os.tmpdir() } = {}) {
  let runtimeDir;
  try {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Tailscale requires a non-root app uid');
    // Opus plan review of #965: a fixed /tmp name could be preclaimed by the media uid.
    runtimeDir = fsImpl.mkdtempSync(path.join(tmpDir, 'nightlight-tailscale-'));
    const initial = fsImpl.lstatSync(runtimeDir);
    if (initial.isSymbolicLink() || !initial.isDirectory() || initial.uid !== uid) throw new Error('runtime directory owner or type is wrong');
    fsImpl.chmodSync(runtimeDir, DIR_MODE);
    verifyDir(runtimeDir, uid, fsImpl);
    const socketPath = path.join(runtimeDir, SOCKET_NAME);
    if (Buffer.byteLength(socketPath) > 107) throw new Error('socket path exceeds Unix socket limit');
    // MEASURED 2026-11-03: tailscaled creates its socket 0666; the 0700 parent is the protection.
    return { ok: true, runtimeDir, socketPath };
  } catch (err) {
    if (runtimeDir) { try { fsImpl.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ok: false, reason: err.message };
  }
}

export function removeRuntimeDir(runtimeDir, { fsImpl = fs } = {}) {
  try { if (runtimeDir) fsImpl.rmSync(runtimeDir, { recursive: true, force: true }); }
  catch { /* the supervisor must not throw during shutdown */ }
}
