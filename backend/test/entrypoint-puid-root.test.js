// #555 bullet 6: PUID=0 used to be accepted silently, and `usermod -o -u 0` then makes the app run as root, which
// backend/entrypoint.sh exists to avoid. It now prints ONE warning and carries on (a refusal or a substituted uid
// is an owner decision, see the PR). This runs the REAL script with usermod/groupmod/chown/su-exec/id stubbed as
// entrypoint-umask.test.js does (only what needs root or the image is stubbed). Linux only, like that file.
//
// Pinned: PUID=0, 00 and 000 warn; the default (unset), 99, 1000, 10 and 099 do not (099 is uid 99; a check that
// looked for "contains a 0" would flag 10 and 1000); a non-number does not warn here (usermod rejects it, as
// before); and the script still reaches the app in every case (the warning must not stop a start).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'entrypoint.sh');
const skip = process.platform === 'linux' ? false : 'POSIX shell: Linux only (runs in CI)';
const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\nexit 0\n',
  'su-exec': '#!/bin/sh\nshift\nexec "$@"\n',
  node: '#!/bin/sh\nexit 0\n', // the #553 phase 2a move into private/: not what this file tests
};
let ROOT;
let STUB_DIR;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-puid-'));
  STUB_DIR = path.join(ROOT, 'bin');
  fs.mkdirSync(STUB_DIR);
  for (const [n, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, n), body, { mode: 0o755 });
});
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function run(puid) {
  const data = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const env = { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: data };
  if (puid !== undefined) env.PUID = puid;
  const r = spawnSync('/bin/sh', [SCRIPT, '/bin/sh', '-c', 'echo APP-RAN'], { env, encoding: 'utf8', timeout: 30_000 });
  return { warnings: r.stderr.split('\n').filter((l) => l.includes('PUID=0')), ran: r.stdout.includes('APP-RAN'), r };
}

describe('PUID=0', { skip }, () => {
  for (const v of ['0', '00', '000']) {
    test(`PUID=${v} warns once and still starts`, () => {
      const { warnings, ran, r } = run(v);
      assert.equal(warnings.length, 1, r.stderr);
      assert.match(warnings[0], /\[entrypoint\] warning: PUID=0 runs the app as root/);
      assert.ok(ran, 'the warning must not stop the container starting');
    });
  }
  for (const v of [undefined, '99', '1000', '10', '099', 'abc', '']) {
    test(`PUID=${JSON.stringify(v)} does not warn`, () => {
      const { warnings, ran, r } = run(v);
      assert.deepEqual(warnings, [], r.stderr);
      assert.ok(ran);
    });
  }
});
