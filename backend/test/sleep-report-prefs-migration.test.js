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

const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;

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
