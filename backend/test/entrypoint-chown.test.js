// #567 bullet 3: backend/entrypoint.sh no longer runs `chown -R` over the whole data directory on every start.
//
// THE PROBLEM. With many GB of clips under DATA_DIR/clips, the recursive chown rewrote every inode on every
// container start, to change nothing. It now runs only when the data directory, or the database / .jwt_secret
// files, are not already owned by PUID:PGID. See the comment above the check in the script for the trade-off
// (a wrong owner DEEPER in the tree is no longer repaired at start).
//
// HOW. Same technique as entrypoint-umask.test.js: the REAL script, with only what needs root or the image
// stubbed by a directory first on PATH (id, usermod, groupmod, su-exec, and chown, which here only RECORDS its
// arguments). stat is the real one, because the ownership check is what is under test, except in the "stat
// stubbed" cases, where a wrapper fakes the owner of ONE named path and hands every other call to the real stat.
//
// WHAT THE TEST CAN AND CANNOT SHOW.
//   - It runs as whoever runs the suite, so "right owner" is "PUID:PGID = my own uid:gid" and "wrong owner" is a
//     PUID/PGID that is not mine. That proves the DIRECTORY check in both directions.
//   - The "database file has the wrong owner inside a right directory" case needs a file owned by someone else,
//     which only root can create. Those cases are SKIPPED unless the suite runs as root. ⚠️ An earlier version of
//     this comment said CI ran them as root: it did not (post-merge review of PR #701). The `unit` job runs as the
//     unprivileged `runner` user and skipped them, so checking the directory alone (`stat ... "$DATA_DIR"` for
//     every name, mutant E1) passed every test that ran. Two fixes, both here:
//       1. CI now runs THIS FILE as root inside node:24-alpine (.github/workflows/test.yml, the BusyBox step),
//          and fails if anything is skipped there. That run is also what proves BusyBox `stat -L -c %u:%g`.
//       2. The "stat stubbed" cases below cover the same per-file rule as ANY user, on any Linux (so the mutation
//          catalogue, which runs unprivileged, can kill E1 too).
//   - It does not run a real chown, and nothing here runs on Windows (no POSIX ownership; reported SKIPPED).
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

// node: the #553 phase 2a move into private/ does nothing here (entrypoint-private-layout.test.js tests it); in the
// BusyBox run as root the host's better-sqlite3 could not even load.
const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\necho "STUB chown $*"\n',
  'su-exec': '#!/bin/sh\nshift\nexec "$@"\n',
  node: '#!/bin/sh\nexit 0\n',
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

// The "stat stubbed" wrapper (#701 review). It answers `%u:%g` for the ONE path ending in /$NL_FAKE_SUFFIX with
// $NL_FAKE_OWNER, and passes every other call (other paths, the `%a` modes line) to the real stat, so only the
// ownership of that one path is invented. The suffix is matched with a leading slash, so "babymonitor.db" does not
// also match "babymonitor.db-wal", and "." matches "$DATA_DIR/." (the directory check) and nothing else.
const STAT_WRAPPER = [
  '#!/bin/sh',
  'for last; do :; done',
  'case "$last" in',
  '  */"$NL_FAKE_SUFFIX") case "$*" in *%u:%g*) printf \'%s\\n\' "$NL_FAKE_OWNER"; exit 0 ;; esac ;;',
  'esac',
  'exec "$NL_REAL_STAT" "$@"',
  '',
].join('\n');
let STAT_STUB_DIR;
let REAL_STAT;

function run(dataDir, { puid, pgid, fake }) {
  // NIGHTLIGHT_MEDIA_ISOLATION=0: these are the ownership-walk tests, run with isolation off (it is asked for by default
  // since #553 phase 4, and entrypoint-media-isolation.test.js covers the ownership check with it on).
  const env = { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: dataDir, PUID: String(puid), PGID: String(pgid), NIGHTLIGHT_MEDIA_ISOLATION: '0' };
  if (fake) {
    Object.assign(env, { PATH: `${STAT_STUB_DIR}:${env.PATH}`, NL_REAL_STAT: REAL_STAT, NL_FAKE_SUFFIX: fake.suffix, NL_FAKE_OWNER: fake.owner });
  }
  const r = spawnSync('/bin/sh', [SCRIPT, '/bin/sh', '-c', 'true'], { env, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  const chowns = r.stdout.split('\n').filter((l) => l.startsWith('STUB chown'));
  return { status: r.status, chowns, out: r.stdout, ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}` };
}

// Runs everywhere (reads text, needs no root and no Linux), so the list below cannot drift unseen on a machine
// where the root-only test further down is skipped (#701 review: the -shm entry could be dropped unnoticed).
describe('#567 entrypoint ownership check: which files it looks at', () => {
  test('#701 chown: the sentinel loop names the data directory, the database, BOTH its sidecar files and .jwt_secret', () => {
    // #553 phase 2a: in both places (the top level, where an install not moved yet has them, and private/), and
    // private/ itself, which a `docker exec` as root must not be able to leave root-owned.
    const text = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
    const m = /^for f in (.+); do$/m.exec(text.slice(text.indexOf('NEEDS_CHOWN=')));
    assert.ok(m, 'the sentinel loop is found');
    assert.deepEqual(m[1].split(/\s+/), [
      '.', 'babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', '.jwt_secret',
      'private', 'private/babymonitor.db', 'private/babymonitor.db-wal', 'private/babymonitor.db-shm', 'private/.jwt_secret',
    ]);
  });
});

describe('#567 entrypoint ownership pass', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-chown-'));
    STUB_DIR = path.join(ROOT, 'stubs');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
    STAT_STUB_DIR = path.join(ROOT, 'stat-stub');
    fs.mkdirSync(STAT_STUB_DIR);
    fs.writeFileSync(path.join(STAT_STUB_DIR, 'stat'), STAT_WRAPPER, { mode: 0o755 });
    REAL_STAT = spawnSync('/bin/sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(REAL_STAT.startsWith('/'), `the real stat was not found: ${JSON.stringify(REAL_STAT)}`);
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

  // The stub chown changes nothing, so the private/ the script then makes (as this user) still is not PUID:PGID's,
  // and is given to them by name: the second, non-recursive chown. In the image the walk ran first, so it is the same.
  const privateChown = (data) => `STUB chown nightlight:nightlight ${data}/private`;

  test('#567 chown: a different PUID (changed since the last start) walks the whole directory once', () => {
    const data = freshData();
    const r = run(data, { puid: UID + 1, pgid: GID });
    assert.deepEqual(r.chowns, [`STUB chown -R nightlight:nightlight ${data}`, privateChown(data)], r.ctx);
    assert.match(r.out, /ownership of .* is not \d+:\d+; fixing the whole data directory/, r.ctx);
  });

  test('#567 chown: a different PGID alone also walks it (the group is half of the pair)', () => {
    const data = freshData();
    const r = run(data, { puid: UID, pgid: GID + 1 });
    assert.equal(r.chowns.filter((c) => c.startsWith('STUB chown -R ')).length, 1, r.ctx);
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

  // #701 review, mutant E1: the case above that a non-root CI never ran, as any user.
  test('#701 review chown (stat stubbed): a database, -wal, -shm or .jwt_secret owned by someone else walks the tree, as any user', () => {
    for (const f of ['babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', '.jwt_secret']) {
      const data = freshData();
      for (const g of ['babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', '.jwt_secret']) fs.writeFileSync(path.join(data, g), 'x');
      const r = run(data, { puid: UID, pgid: GID, fake: { suffix: f, owner: `${UID + 4242}:${GID}` } });
      assert.equal(r.status, 0, `${f}${r.ctx}`);
      assert.equal(r.chowns.length, 1, `${f}${r.ctx}`);
      assert.ok(r.out.includes(`${data}/${f} is not ${UID}:${GID}`), `${f}${r.ctx}`);
    }
  });

  test('#701 review chown (stat stubbed): the stub alone changes nothing (every path reported as PUID:PGID is not walked)', () => {
    // The control for the case above: the same wrapper on PATH, faking the right owner, must not cause a walk.
    const data = freshData();
    fs.writeFileSync(path.join(data, 'babymonitor.db'), 'x');
    const r = run(data, { puid: UID, pgid: GID, fake: { suffix: 'babymonitor.db', owner: `${UID}:${GID}` } });
    assert.deepEqual(r.chowns, [], r.ctx);
    assert.match(r.out, /\[entrypoint\] umask .* modes: private=\d+ babymonitor\.db=\d+ /, `the modes line still reads the real stat${r.ctx}`);
  });

  // #701 review: usermod reads PUID=099 as uid 99, but stat prints 99, so a TEXT comparison never matched and every
  // start walked the whole tree (entrypoint-puid-root.test.js keeps 099 legitimate).
  test('#701 review chown: a PUID and PGID written with leading zeros are compared as numbers, so a right tree is not walked', () => {
    const data = freshData();
    fs.writeFileSync(path.join(data, 'babymonitor.db'), 'x');
    const r = run(data, { puid: `00${UID}`, pgid: `0${GID}` });
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.chowns, [], r.ctx);
    assert.match(r.out, new RegExp(`data directory already owned by ${UID}:${GID}; not walking it`), r.ctx);
  });

  test('#701 review chown: a leading-zero PUID that is really a different id still walks', () => {
    const data = freshData();
    const r = run(data, { puid: `0${UID + 1}`, pgid: `0${GID}` });
    assert.deepEqual(r.chowns, [`STUB chown -R nightlight:nightlight ${data}`, privateChown(data)], r.ctx);
    assert.match(r.out, new RegExp(`is not ${UID + 1}:${GID}; fixing the whole data directory`), r.ctx);
  });

  test('#701 review chown (stat stubbed): PUID=000 PGID=00 is 0:0, not an empty id, so a root-owned tree is not walked', () => {
    // All zeros strip to nothing; the canonical form must still be 0. Faked so it runs as any user: the directory
    // reports 0:0 and nothing else is present.
    const data = freshData();
    const r = run(data, { puid: '000', pgid: '00', fake: { suffix: '.', owner: '0:0' } });
    assert.equal(r.status, 0, r.ctx);
    // No walk. (private/, made by this user and not faked, is not 0:0's unless this user IS root, as in CI's BusyBox
    // run of this file, so it alone may be given to them by name.)
    assert.deepEqual(r.chowns, UID === 0 && GID === 0 ? [] : [privateChown(data)], r.ctx);
    assert.match(r.out, /data directory already owned by 0:0; not walking it/, r.ctx);
  });
});
