// #553 phase 1: spawnChild() runs every child through media-exec.sh when, and only when, MEDIA_ISOLATION is 'on'.
//
//   off (unset, 'off', or anything but exactly 'on')  the program itself is spawned, exactly as before #553
//   on                                                 media-exec.sh is spawned with the program and its arguments after
//                                                      it, the same options, the same allowlisted environment
// and the wrapper itself (the REAL backend/media-exec.sh, run with a stub `setpriv` first on PATH that records its
// arguments and then execs the program, as the real one does after switching user):
//   - hands setpriv exactly --reuid=1700 --regid=1700 --groups=1700 --inh-caps=-all --ambient-caps=-all --no-new-privs;
//   - sets umask 007 for the program;
//   - execs, so the pid spawn() returned IS the program's (every kill in the app relies on that);
//   - passes the arguments through untouched ("$@": a space, a glob character);
//   - forwards neither MEDIA_ISOLATION nor NIGHTLIGHT_MEDIA_ISOLATION nor any secret (the childEnv allowlist).
// The stub cannot switch users, so the uid and the capabilities are NOT shown here: that is
// entrypoint-media-isolation-real.test.js (root, real setpriv) and e2e/media-isolation.sh (the image).
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild, mediaIsolationOn, MEDIA_EXEC_PATH, MEDIA_UID, MEDIA_GID } from '../src/lib/childEnv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ON_LINUX = process.platform === 'linux';
const KEYS = ['MEDIA_ISOLATION', 'NIGHTLIGHT_MEDIA_ISOLATION', 'JWT_SECRET', 'PATH'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// Spawn and wait for the end, collecting stdout. 'error' is listened for, so a spawn that fails (the wrapper on a
// machine with no sh) cannot throw.
function runChild(command, args) {
  return new Promise((resolve) => {
    const proc = spawnChild(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => resolve({ proc, out, err, error: e }));
    proc.on('close', (code) => resolve({ proc, out, err, code }));
  });
}

describe('#553 spawnChild: which program is spawned', () => {
  test('the wrapper is backend/media-exec.sh, found from childEnv.js itself (so /app/media-exec.sh in the image)', () => {
    assert.equal(MEDIA_EXEC_PATH, path.join(HERE, '..', 'media-exec.sh'));
    assert.ok(fs.existsSync(MEDIA_EXEC_PATH), 'media-exec.sh is not where spawnChild looks for it');
    assert.equal(MEDIA_UID, 1700);
    assert.equal(MEDIA_GID, 1700);
  });

  test('off: unset, "off", and anything but exactly "on" spawn the program itself, as before #553', async () => {
    for (const v of [undefined, 'off', 'ON', 'On', '1', 'true', ' on', 'on ']) {
      if (v === undefined) delete process.env.MEDIA_ISOLATION; else process.env.MEDIA_ISOLATION = v;
      assert.equal(mediaIsolationOn(), false, JSON.stringify(v));
      const { proc, code } = await runChild(process.execPath, ['-e', 'process.exit(0)']);
      assert.equal(proc.spawnfile, process.execPath, `${JSON.stringify(v)}: not the program itself`);
      assert.deepEqual(proc.spawnargs, [process.execPath, '-e', 'process.exit(0)'], JSON.stringify(v));
      assert.equal(code, 0);
    }
  });

  // Linux only: Windows refuses to spawn a .sh at all (EFTYPE, thrown, so there is no ChildProcess to look at).
  test('on: the wrapper is spawned with the program and its arguments after it; read at CALL time', { skip: ON_LINUX ? false : 'a .sh cannot be spawned on Windows' }, async () => {
    process.env.MEDIA_ISOLATION = 'on';
    assert.equal(mediaIsolationOn(), true);
    // PATH emptied so the real setpriv (if this machine has one) is never reached: only the argv is under test here.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-nobin-'));
    process.env.PATH = empty;
    try {
      const { proc } = await runChild('ffmpeg', ['-i', 'rtsp://x', 'two words']);
      assert.equal(proc.spawnfile, MEDIA_EXEC_PATH);
      assert.deepEqual(proc.spawnargs, [MEDIA_EXEC_PATH, 'ffmpeg', '-i', 'rtsp://x', 'two words']);
      // EVERY program, not just ffmpeg (review of PR #869): a wrapper applied by name would leave the others running
      // with the app's capabilities. These are the other names src/ spawns, plus two it never does.
      for (const name of ['ffprobe', 'mediamtx', '/usr/bin/ffmpeg', 'anything-else']) {
        const r = await runChild(name, ['-version']);
        assert.equal(r.proc.spawnfile, MEDIA_EXEC_PATH, `${name} was not wrapped`);
        assert.deepEqual(r.proc.spawnargs, [MEDIA_EXEC_PATH, name, '-version'], name);
      }
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('#553 media-exec.sh, run for real with a stub setpriv', { skip: ON_LINUX ? false : 'POSIX sh: Linux only (runs in CI)' }, () => {
  let stubDir;
  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-setpriv-stub-'));
    // Records each argument on its own line, then does what the real setpriv does after the switch: exec the rest.
    fs.writeFileSync(path.join(stubDir, 'setpriv'), [
      '#!/bin/sh',
      "printf 'SETPRIV-ARG %s\\n' \"$@\"",
      'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));

  test('setpriv gets exactly the media drop; the program gets umask 007, the pid, its arguments, no switch or secret', async () => {
    process.env.MEDIA_ISOLATION = 'on';
    process.env.NIGHTLIGHT_MEDIA_ISOLATION = '1';
    process.env.JWT_SECRET = 'planted-jwt-secret';
    process.env.PATH = `${stubDir}:${saved.PATH}`;
    const script = [
      'printf "PID=%s\\n" "$$"',
      'printf "UMASK=%s\\n" "$(umask)"',
      'for a in "$@"; do printf "ARG=%s\\n" "$a"; done',
      'env | sed "s/^/ENV /"',
    ].join('; ');
    const { proc, out, err, code } = await runChild('/bin/sh', ['-c', script, 'sh', 'two words', '*']);
    assert.equal(code, 0, `${out}\n${err}`);
    const lines = out.split('\n');
    const setprivArgs = lines.filter((l) => l.startsWith('SETPRIV-ARG ')).map((l) => l.slice('SETPRIV-ARG '.length));
    assert.deepEqual(setprivArgs.slice(0, 7), [
      `--reuid=${MEDIA_UID}`, `--regid=${MEDIA_GID}`, `--groups=${MEDIA_GID}`,
      '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--',
    ]);
    assert.ok(!setprivArgs.some((a) => a.startsWith('--bounding-set')), 'a bounding-set drop fails under the six-capability hardening');
    assert.equal(lines.find((l) => l.startsWith('PID=')), `PID=${proc.pid}`, 'the program does not have the pid spawn() returned: the wrapper did not exec');
    assert.equal(lines.find((l) => l.startsWith('UMASK=')), 'UMASK=0007');
    assert.deepEqual(lines.filter((l) => l.startsWith('ARG=')), ['ARG=two words', 'ARG=*']);
    const env = lines.filter((l) => l.startsWith('ENV ')).map((l) => l.slice(4).split('=')[0]);
    assert.ok(env.includes('PATH'), 'PATH must reach the wrapper: it finds setpriv by it');
    for (const k of ['MEDIA_ISOLATION', 'NIGHTLIGHT_MEDIA_ISOLATION', 'JWT_SECRET']) assert.equal(env.includes(k), false, `${k} reached the child`);
  });
});
