// #553 phase 2a: backend/entrypoint.sh prepares DATA_DIR/private/ and runs the move into it
// (src/scripts/migrate-private-layout.js) before the app starts.
//
// PINNED HERE:
//   - the move runs ONCE, through su-exec as the app user, in the FOREGROUND, before the app (plan review C1: a start-up
//     that stopped waiting could start the app in the middle of the move);
//   - its exit code becomes ONE line, and NO exit code stops the container (`set -e`, plan review C8);
//   - private/ is made 700 by its own chmod (UMASK=022 too), given to PUID:PGID only when it is not theirs, and left
//     alone, with a warning, when it is a symbolic link or not a folder;
//   - a top-level item the move needs to take, owned by someone else (a restore as root), is re-owned first, by name
//     (never the clip tree, #567; never through a link; not when the full walk already ran);
//   - root not being able to look inside private/ (no DAC_OVERRIDE) is a warning, not a failed start;
//   - the modes line names each file where the app will open it.
// HOW: the REAL script, with only what needs root or the image stubbed on PATH (the entrypoint-umask.test.js technique):
// id, usermod, groupmod, chown (records), su-exec (prints its user and command, then execs), and `node`, standing in
// for the move, which can sleep, leave a marker and exit with any code. `stat` is real, except where a wrapper fakes
// ONE path's owner or makes the look inside private/ fail.
// The REAL move through the script, with a real database, is entrypoint-private-layout-real.test.js (it needs the
// host's better-sqlite3, which node:24-alpine cannot load, and this file also runs there: .github/workflows/test.yml).
// Linux only (POSIX sh, modes and owners).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
const SCRIPT = process.env.ENTRYPOINT_UNDER_TEST || path.join(BACKEND, 'entrypoint.sh');
const skip = process.platform === 'linux' ? false : 'POSIX shell, modes and owners: Linux only (runs in CI)';
const UID = process.getuid?.() ?? 0;
const GID = process.getgid?.() ?? 0;

const NODE_STUB = [
  '#!/bin/sh',
  'printf "STUB node %s\\n" "$*"',
  'if [ "${NL_NODE:-}" = sleep ]; then sleep 1; : > "$NL_MARK"; fi',
  'exit "${NL_NODE_RC:-0}"',
  '',
].join('\n');

const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\necho "STUB chown $*"\n',
  'su-exec': '#!/bin/sh\necho "STUB su-exec $1 $2"\nshift\nexec "$@"\n',
};

// Fakes `%u:%g` for every path ending in /$NL_FAKE_SUFFIX (several, space-separated), and fails a plain look at
// "<private>/." when NL_FAIL_LOOK is set; everything else goes to the real stat.
const STAT_WRAPPER = [
  '#!/bin/sh',
  'for last; do :; done',
  'for s in ${NL_FAKE_SUFFIX:-}; do',
  '  case "$last" in */"$s") case "$*" in *%u:%g*) printf \'%s\\n\' "$NL_FAKE_OWNER"; exit 0 ;; esac ;; esac',
  'done',
  'case "$last" in */private/.) [ -n "${NL_FAIL_LOOK:-}" ] && exit 1 ;; esac',
  'exec "$NL_REAL_STAT" "$@"',
  '',
].join('\n');

const APP = ['/bin/sh', '-c', 'if [ -e "$NL_MARK" ]; then echo "APP after-the-move"; else echo "APP before-the-move"; fi'];

let ROOT;
let STUB_DIR;
let STAT_DIR;
let REAL_STAT;
let n = 0;

function data() {
  n += 1;
  const d = path.join(ROOT, `case-${n}`, 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(dataDir, { env = {}, stat = null } = {}) {
  const mark = path.join(ROOT, `mark-${n}`);
  let PATH = `${STUB_DIR}:${process.env.PATH}`;
  const extra = {};
  if (stat) {
    PATH = `${STAT_DIR}:${PATH}`;
    Object.assign(extra, { NL_REAL_STAT: REAL_STAT, NL_FAKE_SUFFIX: stat.suffix || '', NL_FAKE_OWNER: stat.owner || '', NL_FAIL_LOOK: stat.failLook ? '1' : '' });
  }
  const r = spawnSync('/bin/sh', [SCRIPT, ...APP], {
    // NIGHTLIGHT_MEDIA_ISOLATION=0 by default: the move into private/ is tested with isolation off (it is asked for by
    // default since #553 phase 4); a case can still override it through `env`.
    env: { PATH, DATA_DIR: dataDir, PUID: String(UID), PGID: String(GID), NL_MARK: mark, NIGHTLIGHT_MEDIA_ISOLATION: '0', ...extra, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  const all = `${r.stdout}\n${r.stderr}`.split('\n');
  return {
    status: r.status,
    stdout: r.stdout,
    app: (/^APP (.*)$/m.exec(r.stdout) || [])[1] ?? null,
    nodeRuns: r.stdout.split('\n').filter((l) => l.startsWith('STUB node ')),
    chowns: r.stdout.split('\n').filter((l) => l.startsWith('STUB chown')),
    layoutLines: all.filter((l) => /^\[entrypoint\] (warning: )?private layout: /.test(l)),
    warnings: all.filter((l) => l.startsWith('[entrypoint] warning:')),
    report: all.find((l) => l.startsWith('[entrypoint] umask ')) ?? null,
    ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
  };
}

const modeOf = (p) => (fs.statSync(p).mode & 0o777).toString(8);

describe('#553 phase 2a entrypoint: the private folder and the move', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-ep-private-'));
    STUB_DIR = path.join(ROOT, 'bin');
    STAT_DIR = path.join(ROOT, 'bin-stat');
    for (const d of [STUB_DIR, STAT_DIR]) fs.mkdirSync(d);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
    fs.writeFileSync(path.join(STUB_DIR, 'node'), NODE_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(STAT_DIR, 'stat'), STAT_WRAPPER, { mode: 0o755 });
    REAL_STAT = spawnSync('/bin/sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(REAL_STAT.startsWith('/'), `the real stat was not found: ${JSON.stringify(REAL_STAT)}`);
  });
  after(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

  test('the move runs ONCE, as the app user (su-exec), in the FOREGROUND, and finishes before the app starts', () => {
    // The stub sleeps a second and only then leaves its marker: an app started alongside it (a `&`, a deadline that
    // stopped waiting) would not see the marker.
    const r = run(data(), { env: { NL_NODE: 'sleep' } });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.app, 'after-the-move', `the app started before the move had finished${r.ctx}`);
    assert.equal(r.nodeRuns.length, 1, r.ctx);
    assert.equal(r.nodeRuns[0], `STUB node ${path.join(path.dirname(SCRIPT), 'src', 'scripts', 'migrate-private-layout.js')}`);
    assert.match(r.stdout, /STUB su-exec nightlight node\nSTUB node /, `not started through su-exec as the app user${r.ctx}`);
  });

  test('exit 0: one "private layout:" line, no warning', () => {
    const r = run(data());
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.layoutLines.length, 1, r.ctx);
    assert.match(r.layoutLines[0], /^\[entrypoint\] private layout: the database and secrets are in .*\/private \(or there are none yet\)$/);
    assert.deepEqual(r.warnings, [], r.ctx);
  });

  for (const [rc, says] of [
    ['10', 'something is still at the top of'],
    ['11', 'was set aside in'],
    ['1', 'did not finish (exit 1)'],
    ['127', 'did not finish (exit 127)'],
  ]) {
    test(`exit ${rc}: ONE warning that says so, and the container still starts (set -e cannot stop it)`, () => {
      const r = run(data(), { env: { NL_NODE_RC: rc } });
      assert.equal(r.status, 0, `exit ${rc} stopped the container${r.ctx}`);
      assert.ok(r.app, `the app never started${r.ctx}`);
      assert.equal(r.layoutLines.length, 1, r.ctx);
      assert.ok(r.layoutLines[0].startsWith('[entrypoint] warning: private layout: '), r.layoutLines[0]);
      assert.ok(r.layoutLines[0].includes(says), r.layoutLines[0]);
      assert.ok(r.layoutLines[0].endsWith('; starting anyway'), r.layoutLines[0]);
    });
  }

  test('private/ is created 700 by its own chmod, under UMASK=022 too, and not chowned when it is already PUID:PGID\'s', () => {
    const d = data();
    const r = run(d, { env: { UMASK: '022' } });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(modeOf(path.join(d, 'private')), '700');
    assert.deepEqual(r.chowns, [], r.ctx);
    // ...and loosened by hand, it is tightened again on the next start.
    fs.chmodSync(path.join(d, 'private'), 0o755);
    run(d);
    assert.equal(modeOf(path.join(d, 'private')), '700');
  });

  test('a private/ that is not PUID:PGID\'s is given to them, by name (never a recursive walk)', () => {
    const d = data();
    fs.mkdirSync(path.join(d, 'private'));
    const r = run(d, { stat: { suffix: 'private', owner: '0:0' } });
    assert.equal(r.status, 0, r.ctx);
    // The faked root-owned private/ is ALSO a sentinel: it triggers the full walk, and the by-name chown after it.
    assert.ok(r.chowns.includes(`STUB chown nightlight:nightlight ${d}/private`), r.ctx);
  });

  test('a private/ that is a symbolic link to a folder: what it points to is made 700 THROUGH the link (review of PR #870)', () => {
    // Left at 0755, an old 0644 database could be renamed into a folder others can enter, under UMASK=022, where the
    // tighten walk is off. The link itself stays; the target is owned by this user, so there is no warning.
    const d = data();
    const target = path.join(path.dirname(d), 'elsewhere');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(d, 'private'));
    const r = run(d, { env: { UMASK: '022' } });
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.app, r.ctx);
    assert.equal(modeOf(target), '700', `the link's target was left ${modeOf(target)}${r.ctx}`);
    assert.ok(fs.lstatSync(path.join(d, 'private')).isSymbolicLink(), 'the link was replaced');
    assert.deepEqual(r.warnings, [], r.ctx);
  });

  test('...but it is never chown-ed through the link: a target with the wrong owner gets a warning instead', () => {
    // A root chown through a link the app user could have planted would hand root's files to that user.
    const d = data();
    const target = path.join(path.dirname(d), 'elsewhere');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.symlinkSync(target, path.join(d, 'private'));
    const r = run(d, { stat: { suffix: 'private', owner: '0:0' } });
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.app, r.ctx);
    assert.ok(r.warnings.some((l) => l.includes('is a symbolic link whose target is not owned by')), r.ctx);
    assert.equal(r.chowns.includes(`STUB chown nightlight:nightlight ${d}/private`), false, `chown went through the link${r.ctx}`);
  });

  test('a private/ that is a symbolic link pointing nowhere: a warning, the app still starts', () => {
    const d = data();
    fs.symlinkSync(path.join(path.dirname(d), 'gone'), path.join(d, 'private'));
    const r = run(d);
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.app, r.ctx);
    assert.ok(r.warnings.some((l) => l.includes('is a symbolic link that does not point to a folder')), r.ctx);
  });

  test('a FILE called private: a warning, nothing done to it, the app still starts', () => {
    const d = data();
    fs.writeFileSync(path.join(d, 'private'), 'x');
    const r = run(d);
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.app, r.ctx);
    assert.ok(r.warnings.some((l) => l.includes('exists and is not a folder')), r.ctx);
    assert.equal(fs.readFileSync(path.join(d, 'private'), 'utf8'), 'x');
  });

  test('root cannot look inside private/ (no DAC_OVERRIDE): a warning, and the container still starts', () => {
    const r = run(data(), { stat: { failLook: true } });
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.app, r.ctx);
    assert.ok(r.warnings.some((l) => l.includes('root cannot look inside')), r.ctx);
  });

  test('a top-level item the move takes, owned by someone else (restored as root), is re-owned by name first', () => {
    const d = data();
    for (const f of ['google-services.json', 'firebase-service-account.json', 'babymonitor.db-journal', 'backup-20261001-020304.db']) {
      fs.writeFileSync(path.join(d, f), 'x');
    }
    fs.mkdirSync(path.join(d, 'detection-snapshots'));
    fs.mkdirSync(path.join(d, 'transition-snapshots'));
    const faked = 'google-services.json detection-snapshots backup-20261001-020304.db';
    const r = run(d, { stat: { suffix: faked, owner: `${UID + 4242}:${GID}` } });
    assert.equal(r.status, 0, r.ctx);
    assert.deepEqual(r.chowns.sort(), [
      `STUB chown -R nightlight:nightlight ${d}/backup-20261001-020304.db`,
      `STUB chown -R nightlight:nightlight ${d}/detection-snapshots`,
      `STUB chown -R nightlight:nightlight ${d}/google-services.json`,
    ], `only the three wrong ones, and never the whole data directory${r.ctx}`);
    assert.match(r.stdout, new RegExp(`google-services\\.json is owned by ${UID + 4242}:${GID}, not ${UID}:${GID}; re-owning it`));
  });

  test('...but never through a symbolic link, and not at all when the full walk already re-owned everything', () => {
    const d = data();
    fs.writeFileSync(path.join(d, 'real.json'), '{}');
    fs.symlinkSync(path.join(d, 'real.json'), path.join(d, 'google-services.json'));
    const linked = run(d, { stat: { suffix: 'google-services.json real.json', owner: `${UID + 4242}:${GID}` } });
    assert.deepEqual(linked.chowns, [], linked.ctx);

    const walked = data();
    fs.writeFileSync(path.join(walked, 'google-services.json'), '{}');
    const r = run(walked, { env: { PUID: String(UID + 1) } });
    assert.deepEqual(r.chowns.filter((c) => c.includes('google-services')), [], `the walk already covered it${r.ctx}`);
    assert.ok(r.chowns.includes(`STUB chown -R nightlight:nightlight ${walked}`), r.ctx);
  });

  test('the modes line names each file where the app will open it', () => {
    const moved = data();
    fs.mkdirSync(path.join(moved, 'private'));
    for (const f of ['babymonitor.db', '.jwt_secret']) {
      fs.writeFileSync(path.join(moved, 'private', f), 'x');
      fs.chmodSync(path.join(moved, 'private', f), 0o600);
    }
    const line = run(moved).report;
    assert.ok(line.endsWith('; modes: private=700 private/babymonitor.db=600 private/babymonitor.db-wal=absent ' +
      'private/babymonitor.db-shm=absent private/.jwt_secret=600'), line);

    // Both places have both (a restore put at the top of a moved install): private/ is what the app opens, so it is
    // what the line names, for the database and for .jwt_secret alike.
    const both = data();
    fs.mkdirSync(path.join(both, 'private'));
    for (const f of ['babymonitor.db', '.jwt_secret']) {
      fs.writeFileSync(path.join(both, f), 'x');
      fs.writeFileSync(path.join(both, 'private', f), 'x');
    }
    assert.match(run(both).report, / private\/babymonitor\.db=600 private\/babymonitor\.db-wal=absent private\/babymonitor\.db-shm=absent private\/\.jwt_secret=600$/);

    // The database moved, the secret did not (yet): each where it is.
    const mixed = data();
    fs.mkdirSync(path.join(mixed, 'private'));
    fs.writeFileSync(path.join(mixed, 'private', 'babymonitor.db'), 'x');
    fs.writeFileSync(path.join(mixed, '.jwt_secret'), 'x');
    assert.match(run(mixed).report, / private\/babymonitor\.db=600 .* \.jwt_secret=600$/);
  });
});
