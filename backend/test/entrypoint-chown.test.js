// #567 bullet 3: backend/entrypoint.sh no longer runs `chown -R` over the whole data directory on every start.
//
// THE PROBLEM. With many GB of clips under DATA_DIR/clips, the recursive chown rewrote every inode on every
// container start, to change nothing. It now runs only when the data directory, or the database / .jwt_secret
// files, are not already owned by PUID:PGID. See the comment above the check in the script for the trade-off
// (a wrong owner DEEPER in the tree is no longer repaired at start).
//
// HOW. Same technique as entrypoint-umask.test.js: the REAL script, with only what needs root or the image
// stubbed by a directory first on PATH (id, usermod, groupmod, su-exec, and chown, which here only RECORDS its
// arguments). stat is the real one, because the ownership check is what is under test.
//
// WHAT THE TEST CAN AND CANNOT SHOW.
//   - It runs as whoever runs the suite, so "right owner" is "PUID:PGID = my own uid:gid" and "wrong owner" is a
//     PUID/PGID that is not mine. That proves the DIRECTORY check in both directions.
//   - The "database file has the wrong owner inside a right directory" case needs a file owned by someone else,
//     which only root can create. It runs when the suite runs as root (it does in CI containers), and is
//     reported SKIPPED otherwise, never silently passed.
//   - It does NOT run busybox stat (the image's) or a real chown: `stat -L -c %u:%g` is the same flag set on GNU
//     and BusyBox, but unproven until a run inside node:24-alpine. The existing umask test is run there by CI
//     (.github/workflows/test.yml); this file is not yet added to that job.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.ENTRYPOINT_UNDER_TEST || path.join(HERE, '..', 'entrypoint.sh');
const skip = process.platform === 'linux' ? false : 'POSIX ownership: Linux only';
const IS_ROOT = process.getuid?.() === 0;
const skipNotRoot = skip || (IS_ROOT ? false : 'needs root to create a file owned by someone else');

const UID = process.getuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;

const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\necho "STUB chown $*"\n',
  'su-exec': '#!/bin/sh\nshift\nexec "$@"\n',
};

let ROOT;
let STUB_DIR;
let caseNo = 0;

function freshData() {
  caseNo += 1;
  const d = path.join(ROOT, `case-${caseNo}`, 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(dataDir, { puid, pgid }) {
  const env = { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: dataDir, PUID: String(puid), PGID: String(pgid) };
  const r = spawnSync('/bin/sh', [SCRIPT, '/bin/sh', '-c', 'true'], { env, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  const chowns = r.stdout.split('\n').filter((l) => l.startsWith('STUB chown'));
  return { status: r.status, chowns, out: r.stdout, ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}` };
}

// Runs everywhere (reads text, needs no root and no Linux), so the list below cannot drift unseen on a machine
// where the root-only test further down is skipped (#701 review: the -shm entry could be dropped unnoticed).
describe('#567 entrypoint ownership check: which files it looks at', () => {
  test('#701 chown: the sentinel loop names the data directory, the database, BOTH its sidecar files and .jwt_secret', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
    const m = /^for f in (.+); do$/m.exec(text.slice(text.indexOf('NEEDS_CHOWN=')));
    assert.ok(m, 'the sentinel loop is found');
    assert.deepEqual(m[1].split(/\s+/), ['.', 'babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', '.jwt_secret']);
  });
});

describe('#567 entrypoint ownership pass', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-chown-'));
    STUB_DIR = path.join(ROOT, 'stubs');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  test('#567 chown: a data directory already owned by PUID:PGID is NOT walked, and the log says why', () => {
    const data = freshData();
    fs.writeFileSync(path.join(data, 'babymonitor.db'), 'x');
    const r = run(data, { puid: UID, pgid: GID });
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.chowns, [], r.ctx);
    assert.match(r.out, new RegExp(`data directory already owned by ${UID}:${GID}; not walking it`), r.ctx);
  });

  test('#567 chown: a different PUID (changed since the last start) walks the whole directory once', () => {
    const data = freshData();
    const r = run(data, { puid: UID + 1, pgid: GID });
    assert.deepEqual(r.chowns, [`STUB chown -R nightlight:nightlight ${data}`], r.ctx);
    assert.match(r.out, /ownership of .* is not \d+:\d+; fixing the whole data directory/, r.ctx);
  });

  test('#567 chown: a different PGID alone also walks it (the group is half of the pair)', () => {
    const data = freshData();
    const r = run(data, { puid: UID, pgid: GID + 1 });
    assert.equal(r.chowns.length, 1, r.ctx);
  });

  test('#567 chown: the script still starts the app after skipping, and still prints the umask report line', () => {
    const data = freshData();
    const r = run(data, { puid: UID, pgid: GID });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.out.split('\n').filter((l) => l.startsWith('[entrypoint] umask ')).length, 1, r.ctx);
  });

  test('#567 chown: a database file owned by someone else inside a right directory walks the tree', { skip: skipNotRoot }, () => {
    // Every name the sentinel loop in entrypoint.sh lists (-shm was missing here, #701 review: dropping it from the
    // script passed). Keep this list equal to that loop; the first test in this file reads the script to enforce it.
    for (const f of ['babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', '.jwt_secret']) {
      const data = freshData();
      fs.writeFileSync(path.join(data, f), 'x');
      fs.chownSync(path.join(data, f), UID + 4242, GID);
      const r = run(data, { puid: UID, pgid: GID });
      assert.equal(r.chowns.length, 1, `${f}${r.ctx}`);
      assert.ok(r.out.includes(`${data}/${f} is not`), `${f}${r.ctx}`);
    }
  });

  test('#567 chown: a clip owned by someone else deeper in the tree does NOT trigger the walk (the documented trade-off)', { skip: skipNotRoot }, () => {
    const data = freshData();
    fs.mkdirSync(path.join(data, 'clips'));
    fs.writeFileSync(path.join(data, 'clips', 'a.mp4'), 'x');
    fs.chownSync(path.join(data, 'clips', 'a.mp4'), UID + 4242, GID);
    assert.deepEqual(run(data, { puid: UID, pgid: GID }).chowns, []);
  });
});
