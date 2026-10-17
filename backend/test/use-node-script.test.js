// scripts/use-node.sh puts the Node major from .nvmrc on PATH in a sandbox that came with an older Node (#751).
//
// WHAT THIS PROVES, AND WHAT IT CANNOT. The download path (curl nodejs.org, SHA-256, extract) needs the network and
// a Linux binary, so it is NOT run here: it was exercised by hand on 2026-10-17 (download, checksum and extract
// worked; running the extracted binary could not be tried on the Windows machine it was written on). What IS pinned
// here are the decisions that must hold in every environment and need no network:
//   - a Node that already satisfies .nvmrc is left alone and the script says so (the normal case in CI);
//   - an .nvmrc that is not a bare major version is refused (it is sourced into someone's shell, so it must
//     `return`, never `exit`, and must say what is wrong);
//   - when no way to get the needed Node exists (an OS the script has no download for), it fails with a
//     non-zero status, leaves PATH exactly as it was, and says what to do instead.
// Each case runs the REAL script in a throwaway directory with its own .nvmrc (a copy of the script, so the repo's
// own .nvmrc is never touched). `uname` is replaced by a shell function for the third case so no download is tried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'use-node.sh');
const haveSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const opts = { skip: haveSh ? false : 'needs a POSIX sh' };
const runningMajor = Number(process.versions.node.split('.')[0]);

function run(nvmrc, preamble = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'use-node-'));
  try {
    fs.copyFileSync(SCRIPT, path.join(dir, 'use-node.sh'));
    fs.writeFileSync(path.join(dir, '.nvmrc'), nvmrc);
    // The cwd is not a git repository, so the script falls back to the cwd for .nvmrc (the case in a fresh sandbox).
    const body = `${preamble}\nBEFORE=$PATH\n. ./use-node.sh\nrc=$?\necho "rc=$rc"\n[ "$PATH" = "$BEFORE" ] && echo PATH-UNCHANGED || echo PATH-CHANGED`;
    // Run under the node that is running this suite, so `node` on PATH is the one being judged.
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
    const r = spawnSync('sh', ['-c', body], { cwd: dir, env, encoding: 'utf8' });
    return { out: r.stdout, err: r.stderr, rc: Number(/rc=(\d+)/.exec(r.stdout)?.[1]) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a Node that already satisfies .nvmrc is left alone', opts, () => {
  const r = run(`${runningMajor}\n`);
  assert.equal(r.rc, 0, r.out + r.err);
  assert.match(r.out, /already satisfies/);
  assert.match(r.out, /PATH-UNCHANGED/);
});

test('an older major in .nvmrc than the running one also passes (>=, not ==)', opts, () => {
  const r = run(`${runningMajor - 1}\n`);
  assert.equal(r.rc, 0, r.out + r.err);
  assert.match(r.out, /already satisfies/);
});

test('an .nvmrc that is not a bare major version is refused with a message, and returns instead of exiting', opts, () => {
  for (const bad of ['lts/*\n', 'v24\n', '24.18.0\n', '\n']) {
    const r = run(bad);
    // `echo rc=` after the sourced script only prints if the script RETURNED: an `exit` would have ended the shell.
    assert.equal(r.rc, 1, `${JSON.stringify(bad)}: ${r.out}${r.err}`);
    assert.match(r.err, /must be a bare major version/, JSON.stringify(bad));
  }
});

test('when no way to get the needed Node exists it fails, says what to do, and leaves PATH exactly as it was', opts, () => {
  // A major above the running one, on an OS the script has no download for. The version managers are neutralised so
  // a developer's real fnm/volta never installs anything from a test: NVM_DIR points at an empty directory (no
  // nvm.sh) and fnm/volta are shell functions that fail. The script then reaches the download step and refuses it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'use-node-nvm-'));
  try {
    const r = run(`${runningMajor + 5}\n`, `NVM_DIR='${dir.replace(/\\/g, '/')}'; fnm() { return 1; }; volta() { return 1; }; uname() { case "$1" in -s) echo Plan9 ;; -m) echo mips ;; esac; }`);
    assert.equal(r.rc, 1, r.out + r.err);
    assert.match(r.err, /no download for/);
    assert.match(r.out, /PATH-UNCHANGED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
