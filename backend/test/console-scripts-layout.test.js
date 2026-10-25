// #553 phase 2a: the console scripts people run through `docker exec` (docs/mfa.md, docs/operations.md) find the
// database where the app does, in BOTH layouts, and never create anything: they run as root, and a root-owned empty
// database or private/ folder left on an empty or unreadable volume would shadow the real one or lock the app out.
//
// Each script runs as a real child process against a real database that the app's own db.js created (so the schema
// is the real one), in a temp DATA_DIR.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
const ON_LINUX = process.platform === 'linux';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-console-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// A data directory whose database db.js itself made, with one admin, in the layout asked for. The app leaves its
// database in WAL mode with a -wal beside it (it never closes it), so a "legacy" install is that trio at the top.
function install(layout) {
  n += 1;
  const dir = path.join(ROOT, `data-${n}`);
  fs.mkdirSync(dir);
  const r = spawnSync(process.execPath, ['-e', [
    "import('./src/db.js').then((m) => {",
    "  m.default.prepare(\"INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'admin-a', 'x', 'admin')\").run();",
    '  process.exit(0);',
    '});',
  ].join('\n')], { cwd: BACKEND, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'private', 'babymonitor.db')), 'db.js did not make a private/ database');
  if (layout === 'legacy') {
    // As an install from before #553 has it: the database and its companions at the top, no private/.
    for (const f of fs.readdirSync(path.join(dir, 'private'))) fs.renameSync(path.join(dir, 'private', f), path.join(dir, f));
    fs.rmdirSync(path.join(dir, 'private'));
  }
  return dir;
}

const script = (name, args, dir) => spawnSync(process.execPath, [path.join('src', 'scripts', name), ...args], {
  cwd: BACKEND,
  env: { ...process.env, DATA_DIR: dir },
  encoding: 'utf8',
  timeout: 60_000,
});

describe('#553 reset-mfa.js and promote-admin.js find the database in both layouts', () => {
  for (const layout of ['private', 'legacy']) {
    test(`${layout} layout: both read the real accounts, and nothing new is created`, () => {
      const dir = install(layout);
      const before = fs.readdirSync(dir).sort();
      const mfa = script('reset-mfa.js', ['--list'], dir);
      assert.equal(mfa.status, 0, mfa.stderr);
      assert.match(mfa.stdout, /No users have two-factor enabled\./);
      const promote = script('promote-admin.js', [], dir);
      assert.equal(promote.status, 0, promote.stderr);
      assert.match(promote.stdout, /- admin-a \(admin\)/, 'it opened some OTHER (empty) database');
      assert.deepEqual(fs.readdirSync(dir).sort().filter((f) => !f.endsWith('-shm') && !f.endsWith('-wal')),
        before.filter((f) => !f.endsWith('-shm') && !f.endsWith('-wal')), 'a script created something');
    });
  }

  test('an EMPTY data directory: each script says it cannot open the database, exits 1, and creates NOTHING', () => {
    // What `docker exec` as root on a volume that has never started would otherwise leave behind: a root-owned empty
    // babymonitor.db, or a root-owned private/.
    n += 1;
    const dir = path.join(ROOT, `empty-${n}`);
    fs.mkdirSync(dir);
    for (const [name, args] of [['reset-mfa.js', ['--list']], ['promote-admin.js', []], ['backup-db.js', []]]) {
      const r = script(name, args, dir);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(fs.readdirSync(dir), [], `${name} created something in an empty data directory`);
    }
    assert.match(script('reset-mfa.js', ['--list'], dir).stderr, /Cannot open the Nightlight database at .*private.*babymonitor\.db/);
  });

  test('private/ exists (the start-up made it) but there is no database yet: still nothing is created', () => {
    // The case fileMustExist is for: SQLite makes no folders, but it WOULD make an empty database inside an existing
    // private/, and as root through `docker exec` that file would be root-owned, in the app's own folder.
    n += 1;
    const dir = path.join(ROOT, `noprivdb-${n}`);
    fs.mkdirSync(path.join(dir, 'private'), { recursive: true });
    for (const [name, args] of [['reset-mfa.js', ['--list']], ['promote-admin.js', []], ['backup-db.js', []]]) {
      const r = script(name, args, dir);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'private')), [], `${name} created a database in private/`);
    }
  });

  test('a data directory that does not exist at all is not created either', () => {
    const dir = path.join(ROOT, `missing-${++n}`);
    assert.equal(script('reset-mfa.js', ['--list'], dir).status, 1);
    assert.equal(fs.existsSync(dir), false);
  });
});

describe('#553 backup-db.js (the documented online backup)', () => {
  const backups = (dir) => fs.readdirSync(path.join(dir, 'private')).filter((f) => /^backup-\d{8}-\d{6}(-\d+)?\.db$/.test(f));

  for (const layout of ['private', 'legacy']) {
    test(`${layout} layout: a consistent copy, written into private/ (0600), the database itself untouched`, () => {
      const dir = install(layout);
      if (layout === 'legacy') fs.mkdirSync(path.join(dir, 'private'), { mode: 0o700 }); // the start-up script makes it
      const db = layout === 'private' ? path.join(dir, 'private', 'babymonitor.db') : path.join(dir, 'babymonitor.db');
      const before = sha(db);
      const r = script('backup-db.js', [], dir);
      assert.equal(r.status, 0, r.stderr);
      const [name, ...more] = backups(dir);
      assert.ok(name && more.length === 0, `expected one backup, found ${backups(dir)}`);
      assert.match(r.stdout, new RegExp(`Backup written to .*${name.replace('.', '\\.')}`));
      const copy = new Database(path.join(dir, 'private', name), { readonly: true });
      try {
        assert.equal(copy.prepare("SELECT username FROM users WHERE id = 'u1'").get()?.username, 'admin-a');
      } finally {
        copy.close();
      }
      assert.equal(sha(db), before, 'the backup changed the live database file');
      assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('backup-')), false, 'a copy was left at the top level');
      if (ON_LINUX) assert.equal((fs.statSync(path.join(dir, 'private', name)).mode & 0o777).toString(8), '600');
      // A second backup in the same second gets its own name instead of writing over the first.
      assert.equal(script('backup-db.js', [], dir).status, 0);
      assert.ok(backups(dir).length >= 2);
    });
  }

  test('before private/ exists (an install this version has not started yet): refuses, and creates nothing', () => {
    const dir = install('legacy');
    const before = fs.readdirSync(dir).sort();
    const r = script('backup-db.js', [], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /private does not exist yet/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });

  test('the OLD documented one-liner, run by a cron job after the move, fails read-only and creates no database', () => {
    // docs/operations.md used to give: new Database('/app/data/babymonitor.db', { readonly: true }).backup(...). After
    // the move that path is gone; a read-only open must not create an empty database there (CHANGELOG warning).
    const dir = install('private');
    const oldPath = path.join(dir, 'babymonitor.db');
    assert.throws(() => new Database(oldPath, { readonly: true }), /unable to open database file|directory does not exist/i);
    assert.equal(fs.existsSync(oldPath), false);
  });
});
