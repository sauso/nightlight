// #553 phase 2a: GET /api/about and the diagnostics bundle report where the database is and whether a copy waits for
// the owner's decision. ADDED fields (dataLayout + layoutConflict; data_layout + layout_conflict in the bundle, whose
// keys are snake_case throughout); nothing else in either response changes. Real HTTP, real routers, a real temp
// DATA_DIR; the "legacy" value is checked in a child process, because db.js decides it once, when it loads.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call, mountRouter } from './helpers/harness.js';

const dataDir = useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: aboutRoutes } = await import('../src/routes/about.js');
const { default: diagnosticsRoutes } = await import('../src/routes/diagnostics.js');

let about;
let diag;
let token;
before(async () => {
  makeUser(db, { id: 'u-layout', username: 'layout-admin', role: 'admin' });
  token = signToken({ id: 'u-layout', username: 'layout-admin', role: 'admin', sid: makeSession(db, 'u-layout') });
  about = await mountRouter('/api/about', aboutRoutes);
  diag = await mountRouter('/api/diagnostics', diagnosticsRoutes);
});
after(async () => { await about.close(); await diag.close(); cleanupTempDataDirs(); });

describe('#553 About and diagnostics: dataLayout and layoutConflict', () => {
  test('a fresh install: private, no conflict; the existing About fields are all still there', async () => {
    const res = await call(`${about.url}/api/about`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.dataLayout, 'private');
    assert.equal(res.body.layoutConflict, false);
    for (const k of ['version', 'gitSha', 'gitRef', 'buildTime', 'stunServers', 'publicBaseUrl', 'mediaIsolation']) {
      assert.ok(k in res.body, `${k} went missing (the change must be additive)`);
    }
  });

  test('a set-aside copy in private/legacy-*/ shows as a conflict at once, and clears when it is deleted', async () => {
    const aside = path.join(dataDir, 'private', 'legacy-20261026-101500');
    fs.mkdirSync(aside);
    try {
      assert.equal((await call(`${about.url}/api/about`, { token })).body.layoutConflict, true);
      const bundle = (await call(`${diag.url}/api/diagnostics`, { token })).body;
      assert.equal(bundle.system.data_layout, 'private');
      assert.equal(bundle.system.layout_conflict, true);
    } finally {
      fs.rmSync(aside, { recursive: true });
    }
    assert.equal((await call(`${about.url}/api/about`, { token })).body.layoutConflict, false);
  });

  test('a database at the top level (an install not moved yet) is reported as legacy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-about-legacy-'));
    try {
      new Database(path.join(dir, 'babymonitor.db')).close();
      const r = spawnSync(process.execPath, ['-e', "import('./src/db.js').then((m) => console.log('LAYOUT=' + m.DB_LAYOUT))"], {
        env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
      });
      assert.match(r.stdout, /^LAYOUT=legacy$/m, r.stderr);
      assert.equal(fs.existsSync(path.join(dir, 'private', 'babymonitor.db')), false, 'db.js made a second, empty database');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
