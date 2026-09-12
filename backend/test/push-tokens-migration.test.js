// GHSA-q98f's one-time sweep in db.js: a push_tokens row orphaned BEFORE this fix existed (its
// owning user already deleted, back when nothing cleaned that up) must not sit there forever waiting
// for some unrelated future migration to happen to touch this file again.
//
// Needs two SEPARATE process boots against the SAME database file — db.js's migrations run once, at
// module load, and ES module caching means re-importing it within one process is a no-op, not a
// re-run. The first boot creates the schema and seeds an orphan the normal app code would never
// produce today (bypassing routes/auth.js's own cleanup entirely, the way old, already-orphaned data
// would have arrived). The second boot is what's actually under test: a fresh process opening that
// same file is exactly what a container restart does in production.
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

test('★ THE FIX: a push token orphaned before this migration existed is swept up on the next boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-pushmig-'));
  try {
    runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1','a','h','admin')").run();
       db.prepare("INSERT INTO push_tokens (token, user_id, platform) VALUES ('tok-live','u1','android')").run();
       db.prepare("INSERT INTO push_tokens (token, user_id, platform) VALUES ('tok-orphan','u-gone','android')").run();`
    );

    const out = runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       console.log(JSON.stringify(db.prepare('SELECT token FROM push_tokens ORDER BY token').all()));`
    );

    assert.deepEqual(
      JSON.parse(out.trim()),
      [{ token: 'tok-live' }],
      'a pre-existing orphaned push_tokens row survived a fresh boot on the same database'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
