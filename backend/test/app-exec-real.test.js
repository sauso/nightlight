// Opus plan review of #965: only a real setpriv and Linux /proc can prove that the app's
// ambient capabilities and media group do not reach a tunnel daemon. CI runs as root on Alpine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('../', import.meta.url));
const WRAPPER = path.join(BACKEND, 'app-exec.sh');
const FAKE = path.join(BACKEND, 'test/helpers/fakeTailscaled.js');
const skip = process.platform !== 'linux' ? 'Linux /proc is required'
  : process.getuid?.() !== 0 ? 'root is required to switch to a non-root uid'
    : !/util-linux/.test(spawnSync('setpriv', ['--version'], { encoding: 'utf8' }).stdout ?? '')
      ? 'util-linux setpriv is required' : false;

const waitFor = async (f) => {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('fake daemon did not start');
};

test('#965 app wrapper drops capabilities, extra groups and privilege gain', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-app-exec-'));
  fs.chmodSync(dir, 0o777);
  const uid = 1500, gid = 1500;
  // Match entrypoint.sh's actual isolated app launcher, including ambient caps and group 1700.
  const appDrop = ['--reuid=1500', '--regid=1500', '--groups=1500,1700',
    '--inh-caps=+setuid,+setgid,+kill', '--ambient-caps=+setuid,+setgid,+kill', '--no-new-privs'];
  const child = spawn('setpriv', [...appDrop, '/bin/sh', WRAPPER, String(uid), String(gid), process.execPath, FAKE,
    `--marker-dir=${dir}`, '--mode=list-fds'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitFor(() => fs.existsSync(path.join(dir, `pid-${child.pid}`)));
    const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
    const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(status)?.[1].trim();
    assert.equal(field('Uid')?.split(/\s+/)[0], String(uid));
    assert.equal(field('Gid')?.split(/\s+/)[0], String(gid));
    assert.equal(field('Groups'), String(gid));
    for (const cap of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) assert.match(field(cap), /^0+$/);
    assert.equal(field('NoNewPrivs'), '1');
    const nodeFds = JSON.parse(fs.readFileSync(path.join(dir, `fds-${child.pid}.json`)));
    assert.deepEqual(nodeFds.filter((fd) => fd <= 2).sort(), [0, 1, 2]);
    // Node opens its own epoll/eventfd handles after exec. A shell probe through the same
    // wrapper checks inherited descriptors before a Node runtime opens those internal fds.
    const fds = spawnSync('setpriv', [...appDrop, '/bin/sh', WRAPPER, String(uid), String(gid), '/bin/sh', '-c',
      'for f in /proc/$$/fd/*; do printf "%s\\n" "${f##*/}"; done'], { encoding: 'utf8' });
    assert.equal(fds.status, 0, fds.stderr);
    assert.deepEqual(fds.stdout.trim().split(/\s+/).sort(), ['0', '1', '2']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#965 app wrapper refuses root and malformed uid or gid', { skip }, () => {
  for (const ids of [['0', '1500'], ['00', '1500'], ['1500', '0'], ['1500', '-1'], ['x', '1500']]) {
    const r = spawnSync('/bin/sh', [WRAPPER, ...ids, '/bin/true'], { encoding: 'utf8' });
    assert.equal(r.status, 2, ids.join(':'));
  }
});
