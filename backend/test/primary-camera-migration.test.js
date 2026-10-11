// db.js adds children.primary_camera_id (#655) to an EXISTING install, not only to a fresh database.
//
// Why a separate test: on a fresh database every `ALTER TABLE children` guard in db.js runs, because the
// CREATE TABLE lacks all of them. So a migration nested by mistake inside an older guard (the
// `track_sleep` block sits right above it) would still pass every other test in the suite, and then never
// run on a real install, where track_sleep already exists. This boots db.js on a database shaped like a
// current pre-#655 install (track_sleep present, primary_camera_id absent) and checks the column arrives.
//
// Two process boots against one file, like push-tokens-migration.test.js: db.js migrates once, at module
// load, and re-importing it within one process is a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;

function runInFreshProcess(dir, script) {
  return execFileSync(
    process.execPath,
    ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\n${script}`],
    { encoding: 'utf8' }
  );
}

test('★ a pre-#655 install (track_sleep present, no primary_camera_id) gains the column, NULL for every child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-pcmig-'));
  try {
    // Boot 1: today's schema, then take the column away again and add a child, which leaves exactly the
    // shape of an install that last ran before #655.
    runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       db.exec('ALTER TABLE children DROP COLUMN primary_camera_id');
       db.prepare("INSERT INTO children (id, name) VALUES ('kid-old', 'A child')").run();
       const cols = db.prepare('PRAGMA table_info(children)').all().map((c) => c.name);
       if (!cols.includes('track_sleep') || cols.includes('primary_camera_id')) throw new Error('bad fixture: ' + cols);
       db.close();`
    );

    const out = runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       const cols = db.prepare('PRAGMA table_info(children)').all().map((c) => c.name);
       const kid = db.prepare("SELECT primary_camera_id FROM children WHERE id = 'kid-old'").get();
       console.log(JSON.stringify({ has: cols.includes('primary_camera_id'), kid }));
       db.close();`
    );

    assert.deepEqual(JSON.parse(out.trim()), { has: true, kid: { primary_camera_id: null } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
