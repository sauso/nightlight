// #553 phase 2a: src/lib/dataPaths.js, the one place that says where the database and the app's secrets are.
//
// The rule under test is "EXISTING DATA WINS": every reader resolves by what is on disk, and never picks a place where
// it would create an empty copy next to real data. Real temp directories and real files; nothing mocked. Symbolic-link
// cases skip themselves where the platform will not make a link (Windows without developer mode).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataDirFrom,
  ensurePrivateDir,
  layoutConflict,
  present,
  privateDirOf,
  resolveDbPath,
  resolveDropInFile,
  resolveLayout,
  resolveSecretFile,
  resolveSnapshotDir,
  timestampForName,
} from '../src/lib/dataPaths.js';

const ON_LINUX = process.platform === 'linux';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-data-paths-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
function dir() {
  n += 1;
  const d = path.join(ROOT, `d${n}`);
  fs.mkdirSync(d);
  return d;
}
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
const P = (d, ...rest) => path.join(d, 'private', ...rest);
const T = (d, ...rest) => path.join(d, ...rest);

function linkOrSkip(t, target, at) {
  try {
    fs.symlinkSync(target, at);
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'ENOTSUP') { t.skip(`cannot make a symbolic link here (${e.code})`); return false; }
    throw e;
  }
}

describe('#553 dataPaths: where the database is (the six states)', () => {
  test('nothing anywhere (a fresh install): private', () => {
    const d = dir();
    assert.equal(resolveLayout(d), 'private');
    assert.equal(resolveDbPath(d), P(d, 'babymonitor.db'));
  });

  test('only at the top level (an install not moved yet): legacy, so no second, empty database is created', () => {
    const d = dir();
    touch(T(d, 'babymonitor.db'));
    assert.equal(resolveLayout(d), 'legacy');
    assert.equal(resolveDbPath(d), T(d, 'babymonitor.db'));
  });

  test('only in private/: private', () => {
    const d = dir();
    touch(P(d, 'babymonitor.db'));
    assert.equal(resolveDbPath(d), P(d, 'babymonitor.db'));
  });

  test('in both places: private/ always wins (a restore put at the top of a moved install is NOT used)', () => {
    const d = dir();
    touch(P(d, 'babymonitor.db'));
    touch(T(d, 'babymonitor.db'));
    assert.equal(resolveDbPath(d), P(d, 'babymonitor.db'));
  });

  test('an empty private/ folder alone does not make it legacy or private by itself: the database file decides', () => {
    const d = dir();
    fs.mkdirSync(P(d));
    touch(T(d, 'babymonitor.db'));
    assert.equal(resolveLayout(d), 'legacy', 'private/ exists on every start (the entrypoint makes it); only the file counts');
  });

  test('a top-level database that is a DANGLING symbolic link still counts as there (lstat, not stat)', (t) => {
    // With stat it would read as "nothing", and a fresh empty database would be created in private/ beside the link.
    const d = dir();
    if (!linkOrSkip(t, path.join(d, 'gone.db'), T(d, 'babymonitor.db'))) return;
    assert.equal(present(T(d, 'babymonitor.db')), true);
    assert.equal(resolveLayout(d), 'legacy');
  });
});

describe('#553 dataPaths: secrets, drop-in files and snapshot folders', () => {
  test('.jwt_secret: private first, then the top level, and a NEW one goes into private/', () => {
    const d = dir();
    assert.equal(resolveSecretFile('.jwt_secret', d), P(d, '.jwt_secret'), 'neither: a new one in private/');
    touch(T(d, '.jwt_secret'));
    assert.equal(resolveSecretFile('.jwt_secret', d), T(d, '.jwt_secret'), 'only at the top: used there');
    touch(P(d, '.jwt_secret'));
    assert.equal(resolveSecretFile('.jwt_secret', d), P(d, '.jwt_secret'), 'both: private wins');
  });

  test('a Firebase file: private first, else the TOP level (where the docs say to drop it), even when it is not there', () => {
    const d = dir();
    assert.equal(resolveDropInFile('google-services.json', d), T(d, 'google-services.json'));
    touch(P(d, 'google-services.json'));
    assert.equal(resolveDropInFile('google-services.json', d), P(d, 'google-services.json'));
    touch(T(d, 'google-services.json'));
    assert.equal(resolveDropInFile('google-services.json', d), P(d, 'google-services.json'), 'both: private wins');
  });

  test('a snapshot folder follows its DATABASE: the database\'s place first, then the other, else the database\'s place', () => {
    const legacy = dir();
    touch(T(legacy, 'babymonitor.db'));
    assert.equal(resolveSnapshotDir('detection-snapshots', legacy), T(legacy, 'detection-snapshots'), 'legacy, neither: top');
    fs.mkdirSync(P(legacy, 'detection-snapshots'), { recursive: true });
    assert.equal(resolveSnapshotDir('detection-snapshots', legacy), P(legacy, 'detection-snapshots'), 'legacy, only private/ has one');
    fs.mkdirSync(T(legacy, 'detection-snapshots'));
    assert.equal(resolveSnapshotDir('detection-snapshots', legacy), T(legacy, 'detection-snapshots'),
      'legacy, both: the top-level one, which belongs to the top-level database (NOT private first)');

    const moved = dir();
    touch(P(moved, 'babymonitor.db'));
    assert.equal(resolveSnapshotDir('transition-snapshots', moved), P(moved, 'transition-snapshots'), 'private, neither');
    fs.mkdirSync(T(moved, 'transition-snapshots'));
    assert.equal(resolveSnapshotDir('transition-snapshots', moved), T(moved, 'transition-snapshots'),
      'private, only the top level has one (its move failed): keep serving it from there');
    fs.mkdirSync(P(moved, 'transition-snapshots'));
    assert.equal(resolveSnapshotDir('transition-snapshots', moved), P(moved, 'transition-snapshots'), 'private, both');
  });

  test('layoutConflict: false normally; true with two databases, or while any private/legacy-* copy is kept', () => {
    const d = dir();
    assert.equal(layoutConflict(d), false, 'no private/ at all');
    touch(P(d, 'babymonitor.db'));
    assert.equal(layoutConflict(d), false);
    touch(T(d, 'babymonitor.db'));
    assert.equal(layoutConflict(d), true, 'a top-level database next to the private one');
    fs.rmSync(T(d, 'babymonitor.db'));
    assert.equal(layoutConflict(d), false);
    fs.mkdirSync(P(d, 'legacy-20261026-101500'));
    assert.equal(layoutConflict(d), true, 'a set-aside copy waits for the owner');
    fs.rmSync(P(d, 'legacy-20261026-101500'), { recursive: true });
    assert.equal(layoutConflict(d), false, 'deleting it clears the flag, no restart needed');
  });

  test('resolving never creates anything', () => {
    const d = dir();
    resolveLayout(d); resolveDbPath(d); resolveSecretFile('.jwt_secret', d);
    resolveDropInFile('google-services.json', d); resolveSnapshotDir('detection-snapshots', d); layoutConflict(d);
    assert.deepEqual(fs.readdirSync(d), []);
  });

  test('dataDirFrom: DATA_DIR, else /app/data', () => {
    assert.equal(dataDirFrom({ DATA_DIR: '/x' }), '/x');
    assert.equal(dataDirFrom({}), '/app/data');
    assert.equal(privateDirOf('/x'), path.join('/x', 'private'));
  });

  test('timestampForName: <date>-<time>, zero-padded, in local time', () => {
    assert.equal(timestampForName(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
  });
});

describe('#553 dataPaths: ensurePrivateDir (the writers\' one way to make private/)', () => {
  test('creates it, and makes it 0700 whatever the umask (an explicit chmod)', { skip: ON_LINUX ? false : 'POSIX modes: Linux only' }, () => {
    const d = dir();
    const old = process.umask(0o022);
    try {
      ensurePrivateDir(d);
    } finally {
      process.umask(old);
    }
    assert.equal((fs.statSync(P(d)).mode & 0o777).toString(8), '700');
    fs.chmodSync(P(d), 0o755);
    ensurePrivateDir(d);
    assert.equal((fs.statSync(P(d)).mode & 0o777).toString(8), '700', 'an existing, loosened private/ is tightened again');
  });

  test('a mkdir mode the umask cuts down is corrected too (umask 0277 would make it 0500)', { skip: ON_LINUX ? false : 'POSIX modes: Linux only' }, () => {
    const d = dir();
    const old = process.umask(0o277);
    try {
      ensurePrivateDir(d);
    } finally {
      process.umask(old);
    }
    assert.equal((fs.statSync(P(d)).mode & 0o777).toString(8), '700');
  });

  test('a file called "private" is an error the caller sees, not a silent success', () => {
    const d = dir();
    fs.writeFileSync(P(d), 'not a folder');
    assert.throws(() => ensurePrivateDir(d), /exists and is not a folder/);
  });

  test('a private/ that is a symbolic link is used, and what it points to is made 0700 (review of PR #870)', (t) => {
    const d = dir();
    const elsewhere = path.join(d, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o755 });
    fs.chmodSync(elsewhere, 0o755);
    if (!linkOrSkip(t, elsewhere, P(d), 'dir')) return;
    assert.equal(ensurePrivateDir(d), P(d));
    assert.equal(fs.lstatSync(P(d)).isSymbolicLink(), true, 'the link was replaced');
    if (ON_LINUX) assert.equal((fs.statSync(elsewhere).mode & 0o777).toString(8), '700', 'the target kept its 0755');
  });

  test('a private/ that is a symbolic link pointing nowhere is an error, not a folder made through it', (t) => {
    const d = dir();
    if (!linkOrSkip(t, path.join(d, 'gone'), P(d), 'dir')) return;
    assert.throws(() => ensurePrivateDir(d), /symbolic link to something that does not exist/);
    assert.equal(fs.existsSync(path.join(d, 'gone')), false);
  });
});
