// #549: backend/entrypoint.sh sets the file-creation mask (UMASK, default 077) and, at 077, takes group/other
// access off an existing data directory. Before it, the database (every stored secret), .jwt_secret, snapshots and
// clips were all created 0644 in 0755 folders: readable by every account on the host.
//
// ⚠️ LINUX ONLY, ON PURPOSE. NTFS has no POSIX modes (Git Bash's stat reports a guess from the file's ACL), so on a
// Windows dev machine every test here is SKIPPED, one by one: a skipped describe() is counted by `node --test` as a
// passing suite with no skipped tests, which would hide the skip from scripts/entrypoint-umask.mutants.sh, and that
// script refuses to trust a run with skips in it. Where it really runs (.github/workflows/test.yml):
//   1. `npm test` on Ubuntu: dash + GNU find/stat/chmod;
//   2. inside node:24-alpine, the image's own base, as an unprivileged user: BusyBox sh/find/stat/chmod, the tools
//      production runs, so `-perm /077`, `chmod go-rwx` and `stat -L -c %a` are proven there and not assumed;
//   3. scripts/entrypoint-umask.mutants.sh: each named mutation of the block must turn this file red.
//
// It runs the REAL script (ENTRYPOINT_UNDER_TEST, default the repo's file; the mutants script points it at a mutated
// copy). Only what needs root or the image is stubbed, by a directory placed first on PATH: `id` (answers the default
// 99/100, so usermod/groupmod never run), usermod, groupmod, chown (a no-op: the test is not root and has no
// `nightlight` user), and su-exec (drops the user argument and execs the rest, as the real one does, so the umask
// is inherited the same way). find, stat, chmod, mkdir and wc are the real ones, because they are what is under test.
//
// The script is started from a shell whose umask is 022, Docker's default for a container's first process, so a
// script that forgot to set its own mask is seen with the mask it would really get.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.ENTRYPOINT_UNDER_TEST || path.join(HERE, '..', 'entrypoint.sh');
const ON_LINUX = process.platform === 'linux';
const skip = ON_LINUX ? false : 'POSIX file modes: Linux only (runs in CI; NTFS cannot show them)';
// Root reads a mode-000 folder like any other, so the "unreadable subfolder" case cannot be staged as root.
const skipAsRoot = skip || (process.getuid?.() === 0 ? 'needs an unprivileged user: root can read a 000 folder' : false);

// What the stubbed app does: report the mask it inherited, then create one file and one folder the way the real app,
// FFmpeg and MediaMTX do (open/mkdir with the default 0666/0777, shaped only by the umask).
const APP_SCRIPT = [
  'printf "APP umask=%s\\n" "$(umask)"',
  ': > "$1/app-file"',
  'mkdir -p "$1/app-dir"',
  'printf "APP done\\n"',
].join('; ');

const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) echo "id stub: unexpected: $*" >&2; exit 1 ;; esac\n',
  usermod: '#!/bin/sh\necho "STUB usermod $*"\n',
  groupmod: '#!/bin/sh\necho "STUB groupmod $*"\n',
  chown: '#!/bin/sh\necho "STUB chown $*"\n',
  'su-exec': '#!/bin/sh\nshift\nexec "$@"\n',
};

let ROOT;
let STUB_DIR;
let caseNo = 0;

const oct = (n) => (n & 0o777).toString(8).padStart(3, '0');
const modeOf = (p) => oct(fs.statSync(p).mode);
function mkdir(p, m) { fs.mkdirSync(p, { recursive: true }); fs.chmodSync(p, m); }
function mkfile(p, m) { fs.writeFileSync(p, 'x'); fs.chmodSync(p, m); }
function freshCase() { caseNo += 1; const d = path.join(ROOT, `case-${caseNo}`); fs.mkdirSync(d); return d; }

// Every entry under `dir` (and `dir` itself as '.'), by lstat: a symlink is recorded as 'link' and never followed.
function modes(dir) {
  const out = { '.': modeOf(dir) };
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.lstatSync(p);
      out[r] = st.isSymbolicLink() ? 'link' : oct(st.mode);
      if (st.isDirectory()) walk(p, r);
    }
  })(dir, '');
  return out;
}

function runEntrypoint(dataDir, umaskValue) {
  // A clean environment, so a PUID/PGID/UMASK in the CI runner's own environment cannot leak in.
  const env = { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: dataDir };
  if (umaskValue !== undefined) env.UMASK = umaskValue;
  const r = spawnSync(
    '/bin/sh',
    ['-c', 'umask 022 && exec /bin/sh "$0" "$@"', SCRIPT, '/bin/sh', '-c', APP_SCRIPT, 'app', dataDir],
    { env, encoding: 'utf8', timeout: 30_000 }
  );
  if (r.error) throw r.error;
  const reports = r.stdout.split('\n').filter((l) => l.startsWith('[entrypoint] umask '));
  const m = /^APP umask=([0-7]+)$/m.exec(r.stdout);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    report: reports.length === 1 ? reports[0] : `(${reports.length} report lines)`,
    appUmask: m ? parseInt(m[1], 8) : null,
    appRan: /^APP done$/m.test(r.stdout),
    warnings: `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l.includes('[entrypoint] warning')),
    ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
  };
}

// A data directory as an install from before #549 left it: everything created under Docker's 022. Plus a symlink
// to a file and one to a folder OUTSIDE it, whose modes must never change. Returns the entries the tighten must
// count: every non-link entry with a group/other bit, the directory itself included.
function seedUpgradedInstall(base) {
  const data = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  mkdir(data, 0o755);
  for (const f of ['babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm']) mkfile(path.join(data, f), 0o644);
  // middleware/auth.js creates it 0600, but a copy restored as root, or written by an older version, is 0644.
  mkfile(path.join(data, '.jwt_secret'), 0o644);
  mkfile(path.join(data, 'already-tight.txt'), 0o600);
  // Only the OTHER class has a bit (no group bit): a tighten that looks at group bits only (-perm /070) misses it.
  mkfile(path.join(data, 'other-only.txt'), 0o604);
  mkdir(path.join(data, 'clips'), 0o755);
  mkfile(path.join(data, 'clips', 'a.mp4'), 0o644);
  mkdir(path.join(data, 'other-only-dir'), 0o705);
  mkdir(path.join(outside, 'dir'), 0o755);
  mkfile(path.join(outside, 'target.txt'), 0o644);
  mkfile(path.join(outside, 'dir', 'inner.txt'), 0o644);
  fs.symlinkSync(path.join(outside, 'target.txt'), path.join(data, 'link-to-file'));
  fs.symlinkSync(path.join(outside, 'dir'), path.join(data, 'link-to-dir'));
  // '.', the three database files, .jwt_secret, other-only.txt, clips, clips/a.mp4, other-only-dir
  return { data, outside, loose: 9 };
}

const REPORT_TIGHT = 'modes: babymonitor.db=600 babymonitor.db-wal=600 babymonitor.db-shm=600 .jwt_secret=600';
const REPORT_ABSENT = 'modes: babymonitor.db=absent babymonitor.db-wal=absent babymonitor.db-shm=absent .jwt_secret=absent';

describe('entrypoint.sh: data directory file modes (#549)', () => {
  before(() => {
    if (!ON_LINUX) return;
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-entrypoint-umask-'));
    STUB_DIR = path.join(ROOT, 'stubs');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

  test('default (UMASK unset): the app gets 077, an upgraded tree is tightened, nothing outside it changes', { skip }, () => {
    const { data, outside, loose } = seedUpgradedInstall(freshCase());
    const outsideBefore = modes(outside);
    const r = runEntrypoint(data);
    assert.equal(r.status, 0, `the entrypoint failed${r.ctx}`);
    assert.ok(r.appRan, `the app never ran${r.ctx}`);
    assert.deepEqual(r.warnings, [], `no warning for an unset UMASK${r.ctx}`);
    assert.equal(r.appUmask, 0o077, `the app must inherit 077${r.ctx}`);
    assert.deepEqual(modes(data), {
      '.': '700',
      'babymonitor.db': '600',
      'babymonitor.db-wal': '600',
      'babymonitor.db-shm': '600',
      '.jwt_secret': '600',
      'already-tight.txt': '600',
      'other-only.txt': '600',
      clips: '700',
      'clips/a.mp4': '600',
      'other-only-dir': '700',
      'link-to-file': 'link',
      'link-to-dir': 'link',
      'app-file': '600',
      'app-dir': '700',
    });
    // `! -type l`: chmod follows a symlink, so a link in the data directory must never reach what it points at.
    assert.deepEqual(modes(outside), outsideBefore, 'a file or folder OUTSIDE the data directory changed mode');
    assert.equal(r.report, `[entrypoint] umask 077; existing entries tightened: ${loose}; ${REPORT_TIGHT}`, r.ctx);
    // Pins of what was there before #549: ownership is still fixed on every start, and the default 99/100 needs
    // no remap.
    assert.ok(r.stdout.split('\n').includes(`STUB chown -R nightlight:nightlight ${data}`), r.ctx);
    assert.doesNotMatch(r.stdout, /STUB (usermod|groupmod)/);
  });

  test('every start re-checks, and an already-tight tree is left alone (nothing to count, nothing written)', { skip }, () => {
    const { data } = seedUpgradedInstall(freshCase());
    runEntrypoint(data);
    const r = runEntrypoint(data);
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.report, `[entrypoint] umask 077; existing entries tightened: 0; ${REPORT_TIGHT}`, r.ctx);
    // ...and a later loosening (a restore as root, Unraid's New Permissions tool) heals on the next start.
    fs.chmodSync(path.join(data, 'babymonitor.db'), 0o666);
    fs.chmodSync(data, 0o777);
    const healed = runEntrypoint(data);
    assert.equal(healed.report, `[entrypoint] umask 077; existing entries tightened: 2; ${REPORT_TIGHT}`, healed.ctx);
    assert.equal(modeOf(path.join(data, 'babymonitor.db')), '600');
    assert.equal(modeOf(data), '700');
  });

  test('UMASK=0077 is the default, spelled with four digits: same mask, same tighten, reported as 077', { skip }, () => {
    const { data, loose } = seedUpgradedInstall(freshCase());
    const r = runEntrypoint(data, '0077');
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.warnings, [], r.ctx);
    assert.equal(r.appUmask, 0o077, r.ctx);
    assert.equal(modeOf(path.join(data, '.jwt_secret')), '600');
    assert.equal(modeOf(path.join(data, 'clips')), '700');
    assert.equal(r.report, `[entrypoint] umask 077; existing entries tightened: ${loose}; ${REPORT_TIGHT}`, r.ctx);
  });

  test('UMASK=022 (the opt-out): new files are 0644 again and NOTHING existing is touched', { skip }, () => {
    const { data, outside } = seedUpgradedInstall(freshCase());
    const before = modes(data);
    const outsideBefore = modes(outside);
    const r = runEntrypoint(data, '022');
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.warnings, [], r.ctx);
    assert.equal(r.appUmask, 0o022, r.ctx);
    assert.deepEqual(modes(data), { ...before, 'app-file': '644', 'app-dir': '755' });
    assert.deepEqual(modes(outside), outsideBefore);
    assert.equal(
      r.report,
      '[entrypoint] umask 022; existing entries left as they are (UMASK is not 077); ' +
        'modes: babymonitor.db=644 babymonitor.db-wal=644 babymonitor.db-shm=644 .jwt_secret=644',
      r.ctx
    );
  });

  test('a custom mask (027) on a first boot: the data directory itself is created with it, nothing is chmod-ed', { skip }, () => {
    // Not-yet-existing, two levels deep. The mask must be set BEFORE `mkdir -p`: set after it, the folders mkdir
    // creates get Docker's 022 (0755), and at a non-077 mask nothing tightens them afterwards.
    const base = freshCase();
    const data = path.join(base, 'fresh', 'data');
    const r = runEntrypoint(data, '027');
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.appRan, r.ctx);
    assert.equal(r.appUmask, 0o027, r.ctx);
    assert.equal(modeOf(path.join(base, 'fresh')), '750');
    assert.deepEqual(modes(data), { '.': '750', 'app-file': '640', 'app-dir': '750' });
    assert.equal(r.report, `[entrypoint] umask 027; existing entries left as they are (UMASK is not 077); ${REPORT_ABSENT}`, r.ctx);
  });

  test('first boot at the default: a data directory that does not exist yet is created 0700 and startup goes on', { skip }, () => {
    const data = path.join(freshCase(), 'data');
    const r = runEntrypoint(data);
    assert.equal(r.status, 0, `a first boot must not abort (no database, no .jwt_secret yet)${r.ctx}`);
    assert.ok(r.appRan, r.ctx);
    assert.deepEqual(r.warnings, [], r.ctx);
    // 0 tightened: mkdir -p already ran under 077. (With the mask set after mkdir, this would say 1.)
    assert.equal(r.report, `[entrypoint] umask 077; existing entries tightened: 0; ${REPORT_ABSENT}`, r.ctx);
    assert.deepEqual(modes(data), { '.': '700', 'app-file': '600', 'app-dir': '700' });
  });

  test('an existing but EMPTY data directory: tightened, reported as all absent, startup goes on', { skip }, () => {
    const data = path.join(freshCase(), 'data');
    mkdir(data, 0o755);
    const r = runEntrypoint(data);
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.appRan, r.ctx);
    assert.equal(r.report, `[entrypoint] umask 077; existing entries tightened: 1; ${REPORT_ABSENT}`, r.ctx);
    assert.equal(modeOf(data), '700');
  });

  test('a DATA_DIR that is itself a symlink is walked (find "$DATA_DIR/", with the slash)', { skip }, () => {
    const base = freshCase();
    const real = path.join(base, 'real');
    mkdir(real, 0o755);
    mkfile(path.join(real, 'babymonitor.db'), 0o644);
    mkdir(path.join(real, 'clips'), 0o755);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    const r = runEntrypoint(link);
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(modes(real), { '.': '700', 'babymonitor.db': '600', clips: '700', 'app-file': '600', 'app-dir': '700' });
    assert.equal(
      r.report,
      '[entrypoint] umask 077; existing entries tightened: 3; ' +
        'modes: babymonitor.db=600 babymonitor.db-wal=absent babymonitor.db-shm=absent .jwt_secret=absent',
      r.ctx
    );
  });

  // An owner digit other than 0 (0277, 700, 0777) would create files the app cannot open itself; the rest are typos.
  for (const bad of ['garbage', '9999', '0777', '0277', '700', '77', '0o77', '+077', '0078', '00077']) {
    test(`UMASK=${bad} is refused: one warning, then exactly the default (077, tightened)`, { skip }, () => {
      const data = path.join(freshCase(), 'data');
      mkdir(data, 0o755);
      mkfile(path.join(data, 'babymonitor.db'), 0o644);
      const r = runEntrypoint(data, bad);
      assert.equal(r.status, 0, `an invalid UMASK must never stop the container${r.ctx}`);
      assert.ok(r.appRan, r.ctx);
      assert.equal(r.warnings.length, 1, `exactly one warning${r.ctx}`);
      assert.ok(r.warnings[0].includes(`UMASK=${bad} is not valid`) && r.warnings[0].endsWith('using 077'), r.ctx);
      assert.equal(r.appUmask, 0o077, r.ctx);
      assert.equal(modeOf(path.join(data, 'babymonitor.db')), '600');
      assert.ok(r.report.startsWith('[entrypoint] umask 077; existing entries tightened: 2; '), r.ctx);
    });
  }

  test('UMASK set but BLANK (an Unraid field that was cleared) is the default, silently', { skip }, () => {
    const data = path.join(freshCase(), 'data');
    mkdir(data, 0o755);
    mkfile(path.join(data, 'babymonitor.db'), 0o644);
    const r = runEntrypoint(data, '');
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.warnings, [], `a blank UMASK is not a mistake, so no warning${r.ctx}`);
    assert.equal(r.appUmask, 0o077, r.ctx);
    assert.equal(modeOf(path.join(data, 'babymonitor.db')), '600');
    assert.ok(r.report.startsWith('[entrypoint] umask 077; existing entries tightened: 2; '), r.ctx);
  });

  test('a subfolder the walk cannot read: a warning, the rest is still tightened, and the app still starts', { skip: skipAsRoot }, () => {
    const data = path.join(freshCase(), 'data');
    mkdir(data, 0o755);
    mkfile(path.join(data, 'babymonitor.db'), 0o644);
    const locked = path.join(data, 'locked');
    mkdir(locked, 0o000);
    try {
      const r = runEntrypoint(data);
      assert.equal(r.status, 0, `set -e must not turn a failed walk into a container that will not start${r.ctx}`);
      assert.ok(r.appRan, r.ctx);
      assert.equal(r.warnings.length, 1, r.ctx);
      assert.match(r.warnings[0], /could not tighten every entry under .*; starting anyway$/, r.ctx);
      assert.equal(modeOf(path.join(data, 'babymonitor.db')), '600');
      assert.match(r.report, /^\[entrypoint\] umask 077; existing entries tightened: 2; modes: babymonitor\.db=600 /, r.ctx);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});
