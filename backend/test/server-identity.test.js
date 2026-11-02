// #937: the server's identity (settings.server_id, made once by db.js) and what /api/health says about it
// (lib/serverIdentity.js).
//
// The boot cases run db.js in FRESH processes, the same two-boot shape as sleep-report-prefs-migration.test.js and
// for the same reason: db.js is a module singleton, and "stable across restarts" or "an older database gets one" can
// only be seen by opening the same file twice. On a fresh database every guard runs, so a backfill that ran on EVERY
// boot would pass a single-boot test and only show up as a phone that no longer recognises its server.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dbFile = (dir) => path.join(dir, 'private', 'babymonitor.db');

function runInFreshProcess(dir, script) {
  return execFileSync(process.execPath, ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\n${script}`], { encoding: 'utf8' });
}
// One boot of db.js, then the id it left behind.
const bootAndReadId = (dir) => JSON.parse(runInFreshProcess(
  dir,
  `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
   console.log(JSON.stringify(db.prepare("SELECT server_id FROM settings WHERE id = 'app'").get().server_id));
   db.close();`
).trim());
const readRaw = (dir, sql) => {
  const raw = new Database(dbFile(dir), { readonly: true });
  try { return raw.prepare(sql).all(); } finally { raw.close(); }
};
const withTempDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-srvid-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

describe('settings.server_id (db.js)', () => {
  test('a fresh install gets a random UUID', () => withTempDir((dir) => {
    assert.match(bootAndReadId(dir), UUID);
  }));

  test('★ the id is stable across restarts (made once, never regenerated)', () => withTempDir((dir) => {
    // Without the `IS NULL` guard the backfill writes a new UUID on every boot: every phone would see a new server
    // after each restart. Two further boots, so a guard that only skipped the second boot would also be caught.
    const first = bootAndReadId(dir);
    assert.equal(bootAndReadId(dir), first, 'the second boot changed the server id');
    assert.equal(bootAndReadId(dir), first, 'the third boot changed the server id');
  }));

  test('★ a database from before the column gets the column and an id at its first boot on this build', () => withTempDir((dir) => {
    bootAndReadId(dir);
    // Today's schema with the column taken away again: an install that last ran an older build.
    runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       db.exec('ALTER TABLE settings DROP COLUMN server_id');
       db.close();`
    );
    assert.ok(
      !readRaw(dir, 'PRAGMA table_info(settings)').some((c) => c.name === 'server_id'),
      'precondition: the column is gone'
    );
    assert.match(bootAndReadId(dir), UUID);
  }));

  test('a database that already has an id keeps it (a restore keeps the identity phones know)', () => withTempDir((dir) => {
    bootAndReadId(dir);
    const raw = new Database(dbFile(dir));
    raw.prepare("UPDATE settings SET server_id = 'restored-identity-marker' WHERE id = 'app'").run();
    raw.close();
    assert.equal(bootAndReadId(dir), 'restored-identity-marker');
  }));
});

describe('healthBody() and getServerIdentity()', () => {
  let db;
  let serverIdentity;
  let logger;
  before(async () => {
    useTempDataDir();
    ({ default: db } = await import('../src/db.js'));
    serverIdentity = await import('../src/lib/serverIdentity.js');
    ({ logger } = await import('../src/lib/logger.js'));
  });
  after(() => {
    db.close();
    cleanupTempDataDirs();
  });

  test('★ answers ok, app, the stored id and the app name, and nothing else', () => {
    db.prepare("UPDATE settings SET app_name = 'Upstairs monitor' WHERE id = 'app'").run();
    const { server_id: id } = db.prepare("SELECT server_id FROM settings WHERE id = 'app'").get();
    assert.match(id, UUID);
    // deepEqual, so a key added later (a version, a setup flag) fails here.
    assert.deepEqual(serverIdentity.healthBody(), { ok: true, app: 'nightlight', id, name: 'Upstairs monitor' });
  });

  test('an empty app name reads as "Nightlight"', () => {
    assert.deepEqual(
      serverIdentity.getServerIdentity({ read: () => ({ server_id: 'x', app_name: '' }) }),
      { id: 'x', name: 'Nightlight' }
    );
  });

  test('★ a failed read still answers { ok: true } (a liveness probe never fails because of the identity), with one WARN', () => {
    const warn = mock.method(logger, 'warn', () => {});
    try {
      const read = () => { throw new Error('no such column: server_id'); };
      assert.deepEqual(serverIdentity.healthBody({ read }), { ok: true });
      assert.deepEqual(serverIdentity.healthBody({ read }), { ok: true });
      assert.equal(warn.mock.callCount(), 1, 'one WARN per process, not one per health probe');
      assert.match(String(warn.mock.calls[0].arguments[0]), /server identity/);
    } finally {
      warn.mock.restore();
    }
  });

  test('★ hostile: with a marker in EVERY settings column, only the id and the name come back', () => {
    // The columns come from the schema, not a list typed here, so a column added next year is planted too. A value
    // that leaked would carry its column's marker; a NULL that leaked would look like a field correctly left out.
    const cols = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name).filter((n) => n !== 'id');
    assert.ok(cols.includes('server_id') && cols.includes('app_name') && cols.length > 20, 'read the real schema');
    const saved = db.prepare("SELECT * FROM settings WHERE id = 'app'").get();
    try {
      db.prepare(`UPDATE settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = 'app'`)
        .run(...cols.map((c) => `MARK-${c}`));
      const body = JSON.stringify(serverIdentity.healthBody());
      const leaked = cols.filter((c) => c !== 'server_id' && c !== 'app_name' && body.includes(`MARK-${c}`));
      assert.deepEqual(leaked, [], `settings columns reached /api/health: ${leaked.join(', ')}`);
      assert.ok(body.includes('MARK-server_id') && body.includes('MARK-app_name'), `the fixture reached the reply: ${body}`);
    } finally {
      db.prepare(`UPDATE settings SET ${Object.keys(saved).map((c) => `${c} = ?`).join(', ')} WHERE id = 'app'`)
        .run(...Object.values(saved));
    }
  });

  test('carries no version number (it would help someone find an outdated install)', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const body = serverIdentity.healthBody();
    assert.ok(!('version' in body));
    assert.ok(!JSON.stringify(body).includes(version), `the version ${version} is in ${JSON.stringify(body)}`);
  });
});
