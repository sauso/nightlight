// #553 phase 2a: src/scripts/migrate-private-layout.js, the one-way move of the database and the app's secrets into
// DATA_DIR/private/, which backend/entrypoint.sh runs on every start before the app.
//
// Everything here uses REAL better-sqlite3 and real temp directories. The only seams are the ones a filesystem cannot
// be made to produce on demand: `rename` (to fail as EXDEV does when private/ is a separate mount) and `now` (to run
// out the time budget). The database cases are the point: a WAL-mode database is up to three files, and committed rows
// can live ONLY in -wal, so each "rows survive" case first proves the rows really were only in -wal.
//
// Linux-only parts (file modes, a real read-only folder) skip themselves elsewhere and run in CI; symbolic-link
// cases skip where the platform will not make a link.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migratePrivateLayout, EXIT } from '../src/scripts/migrate-private-layout.js';
import { resolveDbPath, resolveSecretFile, resolveDropInFile, resolveSnapshotDir, layoutConflict } from '../src/lib/dataPaths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'src', 'scripts', 'migrate-private-layout.js');
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3');
const ON_LINUX = process.platform === 'linux';
const IS_ROOT = process.getuid?.() === 0;
const linuxOnly = ON_LINUX ? false : 'POSIX modes: Linux only (runs in CI)';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-migrate-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
function dataDir() {
  n += 1;
  const d = path.join(ROOT, `data-${n}`);
  fs.mkdirSync(d);
  return d;
}
const P = (d, ...rest) => path.join(d, 'private', ...rest);
const T = (d, ...rest) => path.join(d, ...rest);
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const write = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

// Quiet by default; a test that cares reads the lines.
function quiet() {
  const lines = [];
  return { lines, log: { info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`) } };
}
function run(d, opts = {}) {
  const q = quiet();
  const r = migratePrivateLayout({ dataDir: d, env: {}, stamp: () => '20261026-101500', log: q.log, ...opts });
  return { ...r, lines: q.lines };
}

// A WAL-mode database the way the app leaves one: written by a process that is then KILLED without closing it (the app
// never calls close; docs/operations.md, "Backing up"), so the newest rows are only in -wal. Returns the file.
function seedWalDatabase(file, { committed = ['a', 'b'], walOnly = ['wal-only-1', 'wal-only-2'] } = {}) {
  // With no WAL-only rows the -wal is left EMPTY (0 bytes, after the TRUNCATE checkpoint): a crash's leftover.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = [
    `const Database = require(${JSON.stringify(BETTER_SQLITE3)});`,
    `const db = new Database(${JSON.stringify(file)});`,
    "db.pragma('journal_mode = WAL');",
    "db.exec('CREATE TABLE t (x TEXT)');",
    `for (const x of ${JSON.stringify(committed)}) db.prepare('INSERT INTO t VALUES (?)').run(x);`,
    "db.pragma('wal_checkpoint(TRUNCATE)');",
    "db.pragma('wal_autocheckpoint = 0');",
    `for (const x of ${JSON.stringify(walOnly)}) db.prepare('INSERT INTO t VALUES (?)').run(x);`,
    "process.kill(process.pid, 'SIGKILL');",
  ].join('\n');
  spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  if (walOnly.length) {
    assert.ok(fs.statSync(`${file}-wal`).size > 0, 'the seed must leave a non-empty -wal (else "rows survive" proves nothing)');
  } else {
    assert.equal(fs.statSync(`${file}-wal`).size, 0, 'the seed must leave a 0-byte -wal');
  }
  // The .db alone does NOT have the WAL-only rows: a copy of it without its -wal opens without them.
  const alone = path.join(ROOT, `alone-${crypto.randomUUID()}.db`);
  fs.copyFileSync(file, alone);
  const c = new Database(alone, { readonly: true });
  try {
    const xs = c.prepare('SELECT x FROM t').all().map((r) => r.x);
    for (const w of walOnly) assert.ok(!xs.includes(w), `${w} is already in the .db file itself`);
  } finally {
    c.close();
  }
  return file;
}

function rows(file) {
  const c = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return c.prepare('SELECT x FROM t ORDER BY rowid').all().map((r) => r.x);
  } finally {
    c.close();
  }
}

// A plain database (rollback mode, closed cleanly), one row.
function seedPlainDatabase(file, x = 'plain') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const c = new Database(file);
  c.exec('CREATE TABLE t (x TEXT)');
  c.prepare('INSERT INTO t VALUES (?)').run(x);
  c.close();
  return file;
}

function linkOrSkip(t, target, at, type) {
  try {
    fs.symlinkSync(target, at, type);
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'ENOTSUP') { t.skip(`cannot make a symbolic link here (${e.code})`); return false; }
    throw e;
  }
}

describe('#553 move: fresh installs and the database', () => {
  test('fresh install: nothing to move, private/ is created (0700 on Linux), exit 0', () => {
    const d = dataDir();
    const r = run(d);
    assert.equal(r.code, EXIT.DONE);
    assert.deepEqual(fs.readdirSync(d), ['private']);
    assert.deepEqual(fs.readdirSync(P(d)), []);
    if (ON_LINUX) assert.equal(mode(P(d)), '700');
  });

  test('a database with rows only in its -wal: moved as ONE self-contained file, every row survives, no -wal left', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    const r = run(d);
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.deepEqual(r.moved, ['babymonitor.db']);
    for (const f of ['babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', 'babymonitor.db-journal']) {
      assert.equal(fs.existsSync(T(d, f)), false, `${f} is still at the top level`);
    }
    assert.equal(fs.existsSync(P(d, 'babymonitor.db-wal')), false, 'a -wal travelled along');
    // Opened ALONE (a copy of the file only) it has everything: the WAL was merged before the move.
    const alone = path.join(ROOT, `moved-${n}.db`);
    fs.copyFileSync(P(d, 'babymonitor.db'), alone);
    assert.deepEqual(rows(alone), ['a', 'b', 'wal-only-1', 'wal-only-2']);
    assert.ok(r.lines.some((l) => l === 'INFO quick_check of the moved database: ok'), r.lines.join('\n'));
    assert.equal(resolveDbPath(d), P(d, 'babymonitor.db'));
  });

  test('another connection has it open: journal_mode=DELETE is refused, NOTHING moves, the other connection still works', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    const live = new Database(T(d, 'babymonitor.db'));
    try {
      live.prepare('SELECT COUNT(*) AS n FROM t').get();
      const r = run(d);
      assert.equal(r.code, EXIT.LEFT, r.lines.join('\n'));
      assert.deepEqual(r.left, ['babymonitor.db']);
      assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false, 'it moved anyway');
      assert.ok(fs.existsSync(T(d, 'babymonitor.db')));
      assert.ok(r.lines.some((l) => l.startsWith('WARN babymonitor.db stays at the top level this start')), r.lines.join('\n'));
      live.prepare("INSERT INTO t VALUES ('after')").run();
      assert.equal(live.prepare('SELECT COUNT(*) AS n FROM t').get().n, 5);
    } finally {
      live.close();
    }
    assert.deepEqual(rows(T(d, 'babymonitor.db')), ['a', 'b', 'wal-only-1', 'wal-only-2', 'after']);
  });

  test('a companion that survives the close (a stray -wal next to a rollback-mode database): nothing moves', () => {
    // journal_mode=DELETE succeeds here (the database is not in WAL mode, and nothing else has it open), so only the
    // after-close check catches the -wal SQLite never owned. It is left for a person to look at, not deleted.
    const d = dataDir();
    seedPlainDatabase(T(d, 'babymonitor.db'));
    fs.writeFileSync(T(d, 'babymonitor.db-wal'), '');
    const r = run(d);
    assert.equal(r.code, EXIT.LEFT, r.lines.join('\n'));
    assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
    assert.ok(fs.existsSync(T(d, 'babymonitor.db-wal')), 'the stray file was removed');
    assert.ok(r.lines.some((l) => l.includes('babymonitor.db-wal still exists next to it')), r.lines.join('\n'));
  });

  test('a 0-byte -wal left by a crash, with nobody holding the database: SQLite clears it, and the database moves', () => {
    // The control for the case above: the check must not refuse every database that ever crashed.
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'), { walOnly: [] , committed: ['only'] });
    const r = run(d);
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.deepEqual(rows(P(d, 'babymonitor.db')), ['only']);
  });

  test('a file that is not a database: nothing moves (it could not be prepared), exit 10', () => {
    const d = dataDir();
    write(T(d, 'babymonitor.db'), 'this is not an SQLite file, but it is the only copy of something');
    const before = sha(T(d, 'babymonitor.db'));
    const r = run(d);
    assert.equal(r.code, EXIT.LEFT);
    assert.equal(sha(T(d, 'babymonitor.db')), before);
    assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
  });

  test('the rename fails (EXDEV, as when private/ is another mount): NOTHING moves, and the database is intact', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    const exdev = (src) => {
      if (path.basename(src) === 'babymonitor.db') throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      return fs.renameSync(src, src);
    };
    const r = run(d, { rename: exdev });
    assert.equal(r.code, EXIT.LEFT);
    assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
    assert.deepEqual(rows(T(d, 'babymonitor.db')), ['a', 'b', 'wal-only-1', 'wal-only-2']);
    assert.ok(r.lines.some((l) => l.includes('(EXDEV)')), r.lines.join('\n'));
    // The app then opens it where it is.
    assert.equal(resolveDbPath(d), T(d, 'babymonitor.db'));
  });

  test('a read-only data directory (a real EACCES on the rename): nothing moves, every row is still there', {
    skip: linuxOnly || (IS_ROOT ? 'root ignores the folder mode' : false),
  }, () => {
    // The real failure, not the EXDEV seam above. A read-only private/ cannot be staged by its owner (the tool makes
    // its own folder 0700 again), so the folder the file must leave is made read-only instead.
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    fs.mkdirSync(P(d), { mode: 0o700 });
    fs.chmodSync(d, 0o500);
    try {
      const r = run(d);
      assert.equal(r.code, EXIT.LEFT, r.lines.join('\n'));
      assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
      assert.deepEqual(rows(T(d, 'babymonitor.db')), ['a', 'b', 'wal-only-1', 'wal-only-2']);
    } finally {
      fs.chmodSync(d, 0o700);
    }
  });

  test('the time budget runs out before the rename: the database stays, the other passes still run', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    write(T(d, '.jwt_secret'), 'secret-A');
    let t = 0;
    // Every look at the clock is 20 s later: over the 30 s budget by the second check.
    const r = run(d, { now: () => (t += 20_000) });
    assert.equal(r.code, EXIT.LEFT);
    assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
    assert.ok(r.lines.some((l) => l.includes('the time limit for the move ran out')), r.lines.join('\n'));
    assert.equal(fs.readFileSync(P(d, '.jwt_secret'), 'utf8'), 'secret-A', 'the secret pass is independent of the database pass');
  });

  test('a quick_check that fails does NOT stop the move (it is logged only: the plan review cut it as a gate)', () => {
    const d = dataDir();
    const file = T(d, 'babymonitor.db');
    const c = new Database(file);
    c.exec('CREATE TABLE t (x TEXT); CREATE INDEX t_x ON t (x);');
    const ins = c.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 400; i++) ins.run(`row-${i}-${'p'.repeat(40)}`);
    c.close();
    // Corrupt the index's pages: same bytes count, the header and table stay readable, quick_check sees the damage.
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(512, 0x5a), 0, 512, size - 1024);
    fs.closeSync(fd);
    const probe = new Database(file, { readonly: true });
    const before = probe.pragma('quick_check', { simple: true });
    probe.close();
    assert.notEqual(before, 'ok', 'the fixture must actually fail quick_check');
    const r = run(d);
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.ok(fs.existsSync(P(d, 'babymonitor.db')));
    assert.ok(r.lines.some((l) => l.startsWith('WARN quick_check of the moved database reports:')), r.lines.join('\n'));
  });

  test('a symbolic link as the database: NOT moved (it would break), exit 10, and it still resolves', (t) => {
    const d = dataDir();
    const real = seedPlainDatabase(path.join(ROOT, `elsewhere-${n}`, 'real.db'), 'via-link');
    if (!linkOrSkip(t, real, T(d, 'babymonitor.db'))) return;
    const r = run(d);
    assert.equal(r.code, EXIT.LEFT);
    assert.ok(fs.lstatSync(T(d, 'babymonitor.db')).isSymbolicLink());
    assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
    assert.equal(resolveDbPath(d), T(d, 'babymonitor.db'));
    assert.deepEqual(rows(resolveDbPath(d)), ['via-link']);
    assert.ok(r.lines.some((l) => l.startsWith('WARN babymonitor.db is a symbolic link')), r.lines.join('\n'));
  });
});

describe('#553 move: two copies (private/ always wins, nothing is deleted or merged)', () => {
  for (const [what, privRows, topRows] of [
    ['private full, top-level full', ['p1', 'p2'], ['t1']],
    ['private EMPTY, top-level full (no scoring: private still wins)', [], ['t1', 't2', 't3']],
    ['private full, top-level empty', ['p1'], []],
  ]) {
    test(`${what}: the top-level copy and its -wal are set aside in private/legacy-*/, private/ is untouched`, () => {
      const d = dataDir();
      const priv = P(d, 'babymonitor.db');
      fs.mkdirSync(P(d));
      const c = new Database(priv);
      c.exec('CREATE TABLE t (x TEXT)');
      for (const x of privRows) c.prepare('INSERT INTO t VALUES (?)').run(x);
      c.close();
      const privSha = sha(priv);
      seedWalDatabase(T(d, 'babymonitor.db'), { committed: topRows.slice(0, 1), walOnly: topRows.slice(1) });
      const topSha = sha(T(d, 'babymonitor.db'));
      const walSha = sha(T(d, 'babymonitor.db-wal'));
      const r = run(d);
      assert.equal(r.code, EXIT.SET_ASIDE, r.lines.join('\n'));
      assert.equal(sha(priv), privSha, 'the private database was changed');
      const legacy = P(d, 'legacy-20261026-101500');
      assert.equal(sha(path.join(legacy, 'babymonitor.db')), topSha, 'the set-aside database is not byte-for-byte the original');
      assert.equal(sha(path.join(legacy, 'babymonitor.db-wal')), walSha, 'its -wal did not go with it');
      // Together they still open with every row: it can be promoted by hand.
      assert.deepEqual(rows(path.join(legacy, 'babymonitor.db')), topRows);
      assert.equal(fs.existsSync(T(d, 'babymonitor.db')), false);
      assert.equal(layoutConflict(d), true, 'About must show the set-aside copy');
    });
  }

  test('.jwt_secret in both places: the private one stays (nobody is signed out), the other is set aside', () => {
    const d = dataDir();
    write(P(d, '.jwt_secret'), 'private-secret');
    write(T(d, '.jwt_secret'), 'top-secret');
    const r = run(d);
    assert.equal(r.code, EXIT.SET_ASIDE);
    assert.equal(fs.readFileSync(P(d, '.jwt_secret'), 'utf8'), 'private-secret');
    assert.equal(fs.readFileSync(P(d, 'legacy-20261026-101500', '.jwt_secret'), 'utf8'), 'top-secret');
    assert.equal(resolveSecretFile('.jwt_secret', d), P(d, '.jwt_secret'));
  });

  test('a second set-aside in the same second gets its own folder (never overwrites the first)', () => {
    const d = dataDir();
    write(P(d, '.jwt_secret'), 'keep');
    write(T(d, '.jwt_secret'), 'first');
    run(d);
    write(T(d, '.jwt_secret'), 'second');
    const r = run(d);
    assert.equal(r.code, EXIT.SET_ASIDE);
    assert.equal(fs.readFileSync(P(d, 'legacy-20261026-101500', '.jwt_secret'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(P(d, 'legacy-20261026-101500-2', '.jwt_secret'), 'utf8'), 'second');
  });
});

describe('#553 move: the other items, each its own pass on every start', () => {
  test('a crash after the database moved and before the rest: the next start finishes, with no top-level database', () => {
    // The state such a crash leaves, built directly: the database in private/, everything else still at the top.
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(T(d, '.jwt_secret'), 'S');
    write(T(d, 'firebase-service-account.json'), '{"project_id":"p"}');
    write(T(d, 'google-services.json'), '{}');
    write(T(d, 'detection-snapshots', '1.jpg'), 'jpg1');
    write(T(d, 'transition-snapshots', '2.jpg'), 'jpg2');
    const r = run(d);
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(d), ['private']);
    assert.deepEqual(fs.readdirSync(P(d)).sort(), [
      '.jwt_secret', 'babymonitor.db', 'detection-snapshots', 'firebase-service-account.json', 'google-services.json',
      'transition-snapshots',
    ]);
    assert.equal(fs.readFileSync(P(d, 'detection-snapshots', '1.jpg'), 'utf8'), 'jpg1');
    if (ON_LINUX) {
      for (const f of ['.jwt_secret', 'firebase-service-account.json', 'google-services.json']) assert.equal(mode(P(d, f)), '600', f);
    }
  });

  test('the Firebase files made 0644 by hand are 0600 once moved', { skip: linuxOnly }, () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(T(d, 'firebase-service-account.json'), '{}');
    fs.chmodSync(T(d, 'firebase-service-account.json'), 0o644);
    run(d);
    assert.equal(mode(P(d, 'firebase-service-account.json')), '600');
  });

  test('Firebase files dropped at the top of an install already moved: moved at the next start', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    assert.equal(run(d).code, EXIT.DONE);
    write(T(d, 'google-services.json'), '{"dropped":"later"}');
    assert.equal(resolveDropInFile('google-services.json', d), T(d, 'google-services.json'), 'it works at once, from the top');
    const r = run(d);
    assert.deepEqual(r.moved, ['google-services.json']);
    assert.equal(resolveDropInFile('google-services.json', d), P(d, 'google-services.json'));
  });

  test('a Firebase file named by FIREBASE_CREDENTIALS is never moved, nor is the default one while it is set', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(T(d, 'firebase-service-account.json'), '{}');
    write(T(d, 'google-services.json'), '{}');
    const named = T(d, 'my-key.json');
    write(named, '{}');
    const r = run(d, { env: { FIREBASE_CREDENTIALS: named } });
    assert.equal(r.code, EXIT.DONE);
    assert.ok(fs.existsSync(named));
    assert.ok(fs.existsSync(T(d, 'firebase-service-account.json')), 'moved although FIREBASE_CREDENTIALS is set');
    assert.ok(fs.existsSync(P(d, 'google-services.json')), 'its own variable is unset, so it moves');
    const r2 = run(d, { env: { FIREBASE_CLIENT_CONFIG: '/somewhere/else.json' } });
    assert.deepEqual(r2.moved, ['firebase-service-account.json']);
  });

  test('JWT_SECRET set: a top-level .jwt_secret is not used, so it is left (and said); unset: moved, 0600', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(T(d, '.jwt_secret'), 'S');
    const r = run(d, { env: { JWT_SECRET: 'from-the-environment' } });
    assert.equal(r.code, EXIT.DONE);
    assert.ok(fs.existsSync(T(d, '.jwt_secret')));
    assert.ok(r.lines.some((l) => l.includes('is not used (JWT_SECRET is set)')), r.lines.join('\n'));
    assert.deepEqual(run(d).moved, ['.jwt_secret']);
    if (ON_LINUX) assert.equal(mode(P(d, '.jwt_secret')), '600');
  });

  test('snapshot folders stay with a database that stayed at the top (legacy), and move once it has moved', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    write(T(d, 'detection-snapshots', '1.jpg'), 'one');
    // The database cannot move this start (a live connection that has READ it, as the app does from its first
    // query), so its pictures must not either. (A connection that only switched the mode and read nothing does not
    // hold the lock on Linux: the first CI run of this test used one and the database moved. The app is never that.)
    const live = new Database(T(d, 'babymonitor.db'));
    live.prepare('SELECT COUNT(*) AS n FROM t').get();
    try {
      const r = run(d);
      assert.equal(r.code, EXIT.LEFT);
      assert.ok(fs.existsSync(T(d, 'detection-snapshots', '1.jpg')), 'the pictures went ahead of their database');
      assert.equal(fs.existsSync(P(d, 'detection-snapshots')), false);
    } finally {
      live.close();
    }
    const r2 = run(d);
    assert.equal(r2.code, EXIT.DONE, r2.lines.join('\n'));
    assert.equal(fs.readFileSync(P(d, 'detection-snapshots', '1.jpg'), 'utf8'), 'one');
  });

  test('an EMPTY private snapshot folder (the app made it at start) does not block the move: removed, then moved', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    fs.mkdirSync(P(d, 'transition-snapshots'));
    write(T(d, 'transition-snapshots', '7.jpg'), 'seven');
    const r = run(d);
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.equal(fs.readFileSync(P(d, 'transition-snapshots', '7.jpg'), 'utf8'), 'seven');
    assert.equal(fs.existsSync(T(d, 'transition-snapshots')), false);
  });

  test('both snapshot folders hold pictures: the top-level one is set aside WHOLE, nothing is merged by name', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(P(d, 'detection-snapshots', '1.jpg'), 'private-1');
    write(T(d, 'detection-snapshots', '1.jpg'), 'top-1');
    write(T(d, 'detection-snapshots', '2.jpg'), 'top-2');
    const r = run(d);
    assert.equal(r.code, EXIT.SET_ASIDE);
    assert.deepEqual(fs.readdirSync(P(d, 'detection-snapshots')), ['1.jpg']);
    assert.equal(fs.readFileSync(P(d, 'detection-snapshots', '1.jpg'), 'utf8'), 'private-1');
    const aside = P(d, 'legacy-20261026-101500', 'detection-snapshots');
    assert.deepEqual(fs.readdirSync(aside).sort(), ['1.jpg', '2.jpg']);
    assert.equal(fs.readFileSync(path.join(aside, '1.jpg'), 'utf8'), 'top-1');
  });

  test('an empty top-level snapshot folder next to a full private one is simply removed (nothing to keep)', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(P(d, 'detection-snapshots', '1.jpg'), 'p');
    fs.mkdirSync(T(d, 'detection-snapshots'));
    const r = run(d);
    assert.equal(r.code, EXIT.DONE);
    assert.equal(fs.existsSync(T(d, 'detection-snapshots')), false);
  });

  test('backups at the top level (the old documented command put them there) move into private/, 0600 on Linux', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    seedPlainDatabase(T(d, 'backup-20261001-020304.db'), 'backed-up');
    write(T(d, 'backup-notes.txt'), 'not a backup by name: left alone');
    const r = run(d);
    assert.equal(r.code, EXIT.DONE);
    assert.deepEqual(rows(P(d, 'backup-20261001-020304.db')), ['backed-up']);
    assert.ok(fs.existsSync(T(d, 'backup-notes.txt')));
    if (ON_LINUX) assert.equal(mode(P(d, 'backup-20261001-020304.db')), '600');
    write(T(d, 'backup-20261001-020304.db'), 'same name again');
    assert.equal(run(d).code, EXIT.SET_ASIDE, 'a same-named backup is set aside, never written over');
    assert.deepEqual(rows(P(d, 'backup-20261001-020304.db')), ['backed-up']);
  });

  test('a -wal with no database next to it is set aside (it can hold rows), never deleted', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    write(T(d, 'babymonitor.db-wal'), 'orphan');
    const r = run(d);
    assert.equal(r.code, EXIT.SET_ASIDE);
    assert.equal(fs.readFileSync(P(d, 'legacy-20261026-101500', 'babymonitor.db-wal'), 'utf8'), 'orphan');
  });

  test('symbolic links are never moved: .jwt_secret and a snapshot folder', (t) => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    const elsewhere = path.join(ROOT, `links-${n}`);
    write(path.join(elsewhere, 'secret'), 'S');
    fs.mkdirSync(path.join(elsewhere, 'snaps'));
    if (!linkOrSkip(t, path.join(elsewhere, 'secret'), T(d, '.jwt_secret'))) return;
    if (!linkOrSkip(t, path.join(elsewhere, 'snaps'), T(d, 'detection-snapshots'), 'dir')) return;
    const r = run(d);
    assert.equal(r.code, EXIT.LEFT);
    assert.deepEqual(r.left.sort(), ['.jwt_secret', 'detection-snapshots']);
    assert.ok(fs.lstatSync(T(d, '.jwt_secret')).isSymbolicLink());
    assert.ok(fs.lstatSync(T(d, 'detection-snapshots')).isSymbolicLink());
  });

  test('a second run after a full move is a no-op: exit 0, nothing moved, nothing set aside, no new folder', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    write(T(d, '.jwt_secret'), 'S');
    write(T(d, 'detection-snapshots', '1.jpg'), 'x');
    assert.equal(run(d).code, EXIT.DONE);
    const before = fs.readdirSync(P(d)).sort();
    const r = run(d);
    assert.equal(r.code, EXIT.DONE);
    assert.deepEqual([r.moved, r.setAside, r.left], [[], [], []]);
    assert.deepEqual(fs.readdirSync(P(d)).sort(), before);
    assert.deepEqual(r.lines, []);
  });

  test('a file called "private" in the way: nothing moves, exit 10, the database is still used where it is', () => {
    const d = dataDir();
    seedPlainDatabase(T(d, 'babymonitor.db'));
    write(P(d), 'a file, not a folder');
    const r = run(d);
    assert.equal(r.code, EXIT.LEFT);
    assert.deepEqual(r.left, ['babymonitor.db']);
    assert.equal(resolveDbPath(d), T(d, 'babymonitor.db'));
  });
});

// ── The review of PR #870 (Codex sol + Opus): one regression test per finding, each failing without its fix ─────────
// What the app does with the database: open it, switch it to WAL, read (db.js). Used to check what the app would SEE.
function appSees(file) {
  const c = new Database(file);
  try {
    c.pragma('journal_mode = WAL');
    return c.prepare('SELECT x FROM t ORDER BY rowid').all().map((r) => r.x);
  } finally {
    c.close();
  }
}
const legacyDirs = (d) => fs.readdirSync(P(d)).filter((f) => f.startsWith('legacy-')).sort();

describe('#553 move, review of PR #870: what is already in private/ when the database moves in', () => {
  test('HIGH 1 (P6): a stale -wal in private/ with no private database is set aside, so the restored rows are what the app sees', () => {
    // A moved install was stopped (the app never closes its database, so private/ keeps a -wal), then only
    // private/babymonitor.db was deleted and an old-layout copy restored at the top level. Before the fix the copy was
    // moved in next to the old -wal and SQLite replayed the OLD frames over it (Opus, verified by running).
    const d = dataDir();
    seedWalDatabase(P(d, 'babymonitor.db'), { committed: ['live-1'], walOnly: ['live-wal-1', 'live-wal-2'] });
    fs.rmSync(P(d, 'babymonitor.db'));
    seedPlainDatabase(T(d, 'babymonitor.db'), 'restored-1');
    const r = run(d);
    assert.equal(r.code, EXIT.SET_ASIDE, r.lines.join('\n'));
    assert.deepEqual(r.moved, ['babymonitor.db']);
    assert.deepEqual(appSees(resolveDbPath(d)), ['restored-1'], 'the app sees the OLD database\'s rows replayed over the restore');
    const [aside] = legacyDirs(d);
    assert.ok(fs.statSync(P(d, aside, 'babymonitor.db-wal')).size > 0, 'the stale -wal was not kept (it can hold rows): never delete');
    assert.ok(r.lines.some((l) => l.includes('private/babymonitor.db-wal has no private/babymonitor.db beside it')), r.lines.join('\n'));
  });

  test('...and a private/ snapshot folder of that gone database is set aside too; the moved database\'s pictures move in', () => {
    const d = dataDir();
    write(P(d, 'detection-snapshots', '1.jpg'), 'STALE-picture-of-a-gone-database');
    seedPlainDatabase(T(d, 'babymonitor.db'), 'restored');
    write(T(d, 'detection-snapshots', '1.jpg'), 'picture-of-the-restored-database');
    const r = run(d);
    assert.equal(r.code, EXIT.SET_ASIDE, r.lines.join('\n'));
    assert.equal(fs.readFileSync(P(d, 'detection-snapshots', '1.jpg'), 'utf8'), 'picture-of-the-restored-database');
    assert.equal(fs.readFileSync(P(d, legacyDirs(d)[0], 'detection-snapshots', '1.jpg'), 'utf8'), 'STALE-picture-of-a-gone-database');
  });
});

describe('#553 move, review of PR #870: two copies are set aside as a unit', () => {
  // Two copies with the top-level one in WAL mode, its newest rows only in its -wal.
  function twoCopies() {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'), 'winner');
    seedWalDatabase(T(d, 'babymonitor.db'), { committed: ['l1'], walOnly: ['l2-only-in-wal'] });
    return d;
  }

  test('HIGH 2 (P4): if the .db cannot be set aside, NOTHING of it moves: the trio stays together at the top', () => {
    const d = twoCopies();
    const busyDb = (a, b) => {
      if (path.basename(a) === 'babymonitor.db') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.renameSync(a, b);
    };
    const r1 = run(d, { rename: busyDb });
    assert.equal(r1.code, EXIT.LEFT, r1.lines.join('\n'));
    assert.ok(fs.existsSync(T(d, 'babymonitor.db')) && fs.existsSync(T(d, 'babymonitor.db-wal')), 'the -wal left without its database');
    for (const dir of legacyDirs(d)) assert.equal(fs.existsSync(P(d, dir, 'babymonitor.db-wal')), false, `a -wal went aside alone into ${dir}`);
    assert.deepEqual(legacyDirs(d), [], 'an empty legacy-* folder was left, which About reports as a copy waiting');
    // The next start sets all of it aside, into ONE folder, and it still opens with every row.
    const r2 = run(d, { stamp: () => '20261026-101600' });
    assert.equal(r2.code, EXIT.SET_ASIDE, r2.lines.join('\n'));
    const withDb = legacyDirs(d).filter((dir) => fs.existsSync(P(d, dir, 'babymonitor.db')));
    assert.equal(withDb.length, 1);
    assert.ok(fs.existsSync(P(d, withDb[0], 'babymonitor.db-wal')), 'the database and its -wal were set aside apart');
    assert.deepEqual(rows(P(d, withDb[0], 'babymonitor.db')), ['l1', 'l2-only-in-wal']);
  });

  test('HIGH 2: a run cut off between the .db and its -wal: the next start carries the -wal into the SAME folder', () => {
    const d = twoCopies();
    // The .db goes aside, then the "crash": every later rename of this run fails.
    let dbAside = false;
    const crashAfterDb = (a, b) => {
      if (dbAside) throw Object.assign(new Error('killed'), { code: 'EIO' });
      fs.renameSync(a, b);
      if (path.basename(a) === 'babymonitor.db') dbAside = true;
    };
    run(d, { rename: crashAfterDb });
    const [first] = legacyDirs(d);
    assert.ok(fs.existsSync(P(d, first, 'babymonitor.db')) && fs.existsSync(T(d, 'babymonitor.db-wal')), 'precondition: split');
    const r2 = run(d, { stamp: () => '20261026-101600' });
    assert.deepEqual(legacyDirs(d), [first], 'a second legacy-* folder was made for the -wal');
    assert.ok(fs.existsSync(P(d, first, 'babymonitor.db-wal')), r2.lines.join('\n'));
    // The documented promotion (mv legacy-X/babymonitor.db* .) then brings back every row.
    assert.deepEqual(rows(P(d, first, 'babymonitor.db')), ['l1', 'l2-only-in-wal']);
  });

  for (const variant of ['absent', 'empty (the app makes it at start)']) {
    test(`MEDIUM 4 (P1): the losing database's pictures go aside with it, never into private/ (private folder ${variant})`, () => {
      const d = dataDir();
      seedPlainDatabase(P(d, 'babymonitor.db'), 'winner');
      if (variant !== 'absent') fs.mkdirSync(P(d, 'detection-snapshots'));
      seedPlainDatabase(T(d, 'babymonitor.db'), 'loser');
      write(T(d, 'detection-snapshots', '1.jpg'), 'LOSER-PICTURE-FOR-ITS-EVENT-1');
      const r = run(d);
      assert.equal(r.code, EXIT.SET_ASIDE, r.lines.join('\n'));
      const served = resolveSnapshotDir('detection-snapshots', d);
      assert.equal(fs.existsSync(path.join(served, '1.jpg')), false, 'the winner would show the loser\'s picture as its event 1');
      const [aside] = legacyDirs(d);
      assert.equal(fs.readFileSync(P(d, aside, 'detection-snapshots', '1.jpg'), 'utf8'), 'LOSER-PICTURE-FOR-ITS-EVENT-1');
      assert.ok(fs.existsSync(P(d, aside, 'babymonitor.db')), 'not in the same folder as its database');
    });
  }

  test('MEDIUM 4: two databases still there (the set-aside failed): the top-level pictures stay with theirs, and are not served', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'), 'winner');
    seedPlainDatabase(T(d, 'babymonitor.db'), 'loser');
    write(T(d, 'detection-snapshots', '1.jpg'), 'LOSER');
    const busyDb = (a, b) => {
      if (path.basename(a) === 'babymonitor.db') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.renameSync(a, b);
    };
    run(d, { rename: busyDb });
    assert.ok(fs.existsSync(T(d, 'detection-snapshots', '1.jpg')), 'moved away from its database');
    assert.equal(resolveSnapshotDir('detection-snapshots', d), P(d, 'detection-snapshots'), 'the app would serve the loser\'s pictures');
  });
});

describe('#553 move, review of PR #870: the lock, and the checks around the rename', () => {
  test('HIGH 3: a private/ that is a symbolic link: what it points to is made 0700 before anything moves into it', { skip: linuxOnly }, (t) => {
    const d = dataDir();
    const target = path.join(ROOT, `elsewhere-private-${n}`);
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    if (!linkOrSkip(t, target, P(d), 'dir')) return;
    seedPlainDatabase(T(d, 'babymonitor.db'));
    fs.chmodSync(T(d, 'babymonitor.db'), 0o644);
    const r = run(d);
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.equal(mode(target), '700', 'the 0644 database was moved into a folder others can enter');
    assert.ok(fs.existsSync(path.join(target, 'babymonitor.db')));
    assert.ok(fs.lstatSync(P(d)).isSymbolicLink(), 'the link itself was replaced');
  });

  test('HARDENING 6: the exclusive lock is refused (another connection reads between the proof and the lock): nothing moves, exit 10', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    let other = null;
    const r = run(d, {
      busyTimeoutMs: 200,
      hooks: {
        beforeLock() {
          other = new Database(T(d, 'babymonitor.db'));
          other.exec('BEGIN');
          other.prepare('SELECT COUNT(*) FROM t').get();
        },
      },
    });
    try {
      assert.equal(r.code, EXIT.LEFT, r.lines.join('\n'));
      assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false, 'it moved while another connection was reading it');
      assert.ok(r.lines.some((l) => l.includes('could not be prepared for the move (database is locked)')), r.lines.join('\n'));
    } finally {
      other?.exec('COMMIT');
      other?.close();
    }
    assert.deepEqual(rows(T(d, 'babymonitor.db')), ['a', 'b', 'wal-only-1', 'wal-only-2']);
  });

  test('M10: a journal-mode change SQLite answers with the old mode (instead of an error) moves nothing', () => {
    // SQLite documents that answer; no real fixture produces it (a second connection makes it throw), so the
    // connection here is the real one with only that answer changed.
    const d = dataDir();
    seedPlainDatabase(T(d, 'babymonitor.db'));
    const openDatabase = (file, opts) => {
      const real = new Database(file, opts);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'pragma') return (sql, o) => (/^journal_mode/.test(sql) ? 'wal' : target.pragma(sql, o));
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    };
    const r = run(d, { openDatabase });
    assert.equal(r.code, EXIT.LEFT);
    assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
    assert.ok(r.lines.some((l) => l.includes('its journal mode stayed "wal"')), r.lines.join('\n'));
  });

  test('M11: a private/babymonitor.db that appears before the rename is never replaced (rename(2) would)', () => {
    const d = dataDir();
    seedPlainDatabase(T(d, 'babymonitor.db'), 'top');
    // Any rename ONTO an existing private database counts, even one the filesystem then refuses (Windows refuses to
    // rename an open file, which would otherwise hide a missing check there).
    let ontoExisting = false;
    const watch = (a, b) => { if (path.basename(b) === 'babymonitor.db' && fs.existsSync(b)) ontoExisting = true; return fs.renameSync(a, b); };
    const r = run(d, { rename: watch, hooks: { beforeLock() { seedPlainDatabase(P(d, 'babymonitor.db'), 'appeared'); } } });
    assert.equal(ontoExisting, false, 'a rename onto the private database was attempted');
    assert.equal(r.code, EXIT.LEFT, r.lines.join('\n'));
    assert.deepEqual(rows(P(d, 'babymonitor.db')), ['appeared'], 'the private database was replaced');
    assert.deepEqual(rows(T(d, 'babymonitor.db')), ['top']);
  });

  test('M14: the time limit running out AFTER the rename changes nothing (it applies before the rename only)', () => {
    const d = dataDir();
    seedPlainDatabase(T(d, 'babymonitor.db'), 'moved');
    write(T(d, '.jwt_secret'), 'S');
    let renamed = false;
    const r = run(d, {
      now: () => (renamed ? 1e12 : 0),
      rename: (a, b) => { fs.renameSync(a, b); if (path.basename(a) === 'babymonitor.db') renamed = true; },
    });
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.deepEqual(rows(P(d, 'babymonitor.db')), ['moved']);
    assert.equal(fs.existsSync(T(d, 'babymonitor.db')), false, 'renamed back, or copied');
    assert.ok(fs.existsSync(P(d, '.jwt_secret')), 'the passes after the database stopped');
  });

  test('a filesystem that refuses to rename an OPEN file (EBUSY): the lock is let go and the rename tried once more', () => {
    // What Windows does (measured) and some network shares: without the retry the database would never move there.
    const d = dataDir();
    seedPlainDatabase(T(d, 'babymonitor.db'), 'moved');
    let first = true;
    const refusesOnce = (a, b) => {
      if (first && path.basename(a) === 'babymonitor.db') { first = false; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
      return fs.renameSync(a, b);
    };
    const r = run(d, { rename: refusesOnce });
    assert.equal(r.code, EXIT.DONE, r.lines.join('\n'));
    assert.deepEqual(rows(P(d, 'babymonitor.db')), ['moved']);
  });
});

describe('#553 move: the command the entrypoint runs (exit codes from a real process)', () => {
  const cli = (d, env = {}) => spawnSync(process.execPath, [TOOL], {
    env: { ...process.env, DATA_DIR: d, JWT_SECRET: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });

  test('exit 0 after a move, with one log line naming it', () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    const r = cli(d);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[private-layout\] moved babymonitor\.db into private\//);
    assert.ok(fs.existsSync(P(d, 'babymonitor.db')));
  });

  test('exit 10 while ANOTHER PROCESS has the database open (the real lock, across processes)', async () => {
    const d = dataDir();
    seedWalDatabase(T(d, 'babymonitor.db'));
    const holder = spawn(process.execPath, ['-e', [
      `const Database = require(${JSON.stringify(BETTER_SQLITE3)});`,
      `const db = new Database(${JSON.stringify(T(d, 'babymonitor.db'))});`,
      "db.prepare('SELECT COUNT(*) FROM t').get();",
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => {
        holder.stdout.on('data', (b) => { if (String(b).includes('ready')) resolve(); });
        holder.on('exit', () => reject(new Error('the holder exited early')));
      });
      const r = cli(d);
      assert.equal(r.status, 10, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(P(d, 'babymonitor.db')), false);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  test('exit 11 when a copy is set aside', () => {
    const d = dataDir();
    seedPlainDatabase(P(d, 'babymonitor.db'));
    seedPlainDatabase(T(d, 'babymonitor.db'));
    assert.equal(cli(d).status, 11);
  });
});
