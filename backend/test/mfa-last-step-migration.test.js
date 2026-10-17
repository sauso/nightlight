// #550: users.mfa_last_step is added by a hand-written, idempotent migration at the bottom of db.js.
//
// Needs separate process boots against ONE database file for the same reason push-tokens-migration.test.js
// does: db.js migrates at module load, and ES module caching makes a second import in one process a no-op.
// The "old database" is made the honest way: boot once (full current schema), then DROP the new column and
// seed a user the way a pre-upgrade install would hold them. The next boot is what is under test, and it
// is exactly what a container restart after upgrading does.
//
// FAILS ON OLD CODE: before the migration existed there is no mfa_last_step column at all, so the schema
// assertion and the UPDATE in the third boot both throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;

function boot(dir, script) {
  return execFileSync(
    process.execPath,
    ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\nconst { default: db } = await import(${JSON.stringify(DB_JS_URL)});\n${script}`],
    { encoding: 'utf8' }
  ).trim();
}

const columns = `console.log(JSON.stringify(db.prepare('PRAGMA table_info(users)').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value }))));`;

test('★ an old database gains mfa_last_step: nullable, no default, existing rows untouched, and a restart is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-mfastep-'));
  try {
    // Boot 1: current schema. Then regress it to the pre-#550 shape and seed an MFA user. It prints the
    // OLD shape so the comparison below is against a real pre-upgrade table, not a remembered one.
    const oldCols = JSON.parse(boot(dir, `
      db.exec('ALTER TABLE users DROP COLUMN mfa_last_step');
      db.prepare("INSERT INTO users (id, username, password_hash, role, mfa_enabled, mfa_secret, mfa_backup_codes) VALUES ('u1','a','h','admin',1,'SECRETSECRET','[\\"x\\"]')").run();
      ${columns}`));
    assert.ok(!oldCols.some((c) => c.name === 'mfa_last_step'), 'the fixture is not an old database');

    // Boot 2 is the upgrade. Schema-driven: EVERY users column is compared, so any other column the
    // migration changed or dropped shows up, not just the one we expect.
    const after2 = JSON.parse(boot(dir, columns));
    assert.deepEqual(
      after2.filter((c) => c.name !== 'mfa_last_step'),
      oldCols,
      'the migration altered a column other than the one it adds'
    );
    assert.deepEqual(
      after2.find((c) => c.name === 'mfa_last_step'),
      { name: 'mfa_last_step', type: 'INTEGER', notnull: 0, dflt: null }
    );

    const row = JSON.parse(boot(dir, `console.log(JSON.stringify(db.prepare("SELECT username, role, mfa_enabled, mfa_secret, mfa_backup_codes, mfa_last_step FROM users WHERE id='u1'").get()));`));
    assert.deepEqual(row, { username: 'a', role: 'admin', mfa_enabled: 1, mfa_secret: 'SECRETSECRET', mfa_backup_codes: '["x"]', mfa_last_step: null });

    // Idempotent: a value written after the upgrade survives the next boot, and the column list is stable.
    boot(dir, `db.prepare("UPDATE users SET mfa_last_step = 59731501 WHERE id='u1'").run();`);
    const again = JSON.parse(boot(dir, columns));
    assert.deepEqual(again, after2, 'a further boot changed the users schema');
    assert.equal(JSON.parse(boot(dir, `console.log(JSON.stringify(db.prepare("SELECT mfa_last_step AS s FROM users WHERE id='u1'").get().s));`)), 59731501, 're-running the migration clobbered the stored step');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
