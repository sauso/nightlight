// db.js adds the per-child sleep report choices (#397, #398) to an EXISTING install, carrying the old global
// switch's value into each child once. Same two-boot shape as primary-camera-migration.test.js, for the same
// reason: on a fresh database every ALTER guard runs, so a guard nested wrongly or a copy that runs on every boot
// would pass the rest of the suite and only misbehave on a real upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;

// #553 phase 2a: db.js, booted on a fresh data directory (makeOldInstall), makes its database in private/.
const dbFile = (dir) => path.join(dir, 'private', 'babymonitor.db');

function runInFreshProcess(dir, script) {
  return execFileSync(process.execPath, ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\n${script}`], { encoding: 'utf8' });
}

// An install that last ran before these columns: today's schema with them taken away again.
function makeOldInstall(dir, globalValue) {
  runInFreshProcess(
    dir,
    `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
     db.exec('ALTER TABLE children DROP COLUMN sleep_report_enabled');
     db.exec('ALTER TABLE children DROP COLUMN sleep_report_show_name');
     db.prepare("INSERT INTO children (id, name) VALUES ('kid-1', 'First'), ('kid-2', 'Second')").run();
     db.prepare("UPDATE settings SET sleep_report_alert_enabled = ? WHERE id = 'app'").run(${globalValue});
     db.close();`
  );
}
const readKids = (dir) => JSON.parse(runInFreshProcess(
  dir,
  `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
   console.log(JSON.stringify(db.prepare('SELECT id, sleep_report_enabled e, sleep_report_show_name n FROM children ORDER BY id').all()));
   db.close();`
).trim());

test('★ an upgrade keeps today\'s behaviour: report ON, name SHOWN, for every existing child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-srmig-'));
  try {
    makeOldInstall(dir, 1);
    assert.deepEqual(readKids(dir), [{ id: 'kid-1', e: 1, n: 1 }, { id: 'kid-2', e: 1, n: 1 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ a global switch that was OFF is carried into every existing child (nothing starts being sent)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-srmig0-'));
  try {
    makeOldInstall(dir, 0);
    assert.deepEqual(readKids(dir), [{ id: 'kid-1', e: 0, n: 1 }, { id: 'kid-2', e: 0, n: 1 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ a boot that dies between adding the column and copying the old OFF leaves NOTHING behind; the next boot still copies it', () => {
  // Review: the ALTER and the copy are two statements. Had the ALTER committed on its own, a crash before the copy
  // would leave the column present with every child at its default (on), and the guard would never run the copy
  // again: a report the database had switched off would start going out. They are atomic because both sit inside
  // the one schema transaction db.js opens at the top (#258), not in a wrapper of their own. A trigger that aborts
  // any UPDATE on children is the cheapest stand-in for the crash: the ALTER succeeds, then the copy throws (db.js
  // has no other UPDATE on children, and the error text is checked below). Moving this migration after db.js's
  // COMMIT makes this test fail.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-srmig3-'));
  try {
    makeOldInstall(dir, 0);
    const raw = new Database(dbFile(dir));
    raw.exec("CREATE TRIGGER interrupt_copy BEFORE UPDATE ON children BEGIN SELECT RAISE(ABORT, 'interrupted the sleep report copy'); END");
    raw.close();

    assert.throws(() => readKids(dir), /interrupted the sleep report copy/, 'precondition: the boot failed AT the copy');
    const cols = () => {
      const db = new Database(dbFile(dir));
      try { return db.prepare('PRAGMA table_info(children)').all().map((c) => c.name); } finally { db.close(); }
    };
    assert.ok(!cols().includes('sleep_report_enabled'), 'the column survived a boot that died before the copy: the OFF is lost for good');
    assert.ok(!cols().includes('sleep_report_show_name'));

    const fix = new Database(dbFile(dir));
    fix.exec('DROP TRIGGER interrupt_copy');
    fix.close();
    assert.deepEqual(readKids(dir), [{ id: 'kid-1', e: 0, n: 1 }, { id: 'kid-2', e: 0, n: 1 }], 'the retried boot carried the OFF');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ the copy happens once: a later boot never overwrites a choice made on the child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-srmig2-'));
  try {
    makeOldInstall(dir, 0);
    readKids(dir); // boot that migrates
    runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       db.prepare("UPDATE children SET sleep_report_enabled = 1, sleep_report_show_name = 0 WHERE id = 'kid-1'").run();
       db.close();`
    );
    // The global stays 0; the next boots must not copy it again.
    assert.deepEqual(readKids(dir), [{ id: 'kid-1', e: 1, n: 0 }, { id: 'kid-2', e: 0, n: 1 }]);
    assert.deepEqual(readKids(dir), [{ id: 'kid-1', e: 1, n: 0 }, { id: 'kid-2', e: 0, n: 1 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
