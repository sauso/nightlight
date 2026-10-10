// #552 (PR2) claim C8: a database from before "who did it" upgrades on the next boot, keeps every row it had,
// and reads NULL ("nobody recorded") for the new columns on those rows, never an invented name.
//
// Modelled on push-tokens-migration.test.js: separate process boots against the SAME database file, because
// db.js runs its migrations once at module load and re-importing it in this process would be a no-op. Boot 1
// builds today's schema and then REWINDS it (drops exactly the columns this change added) and plants the rows
// an older install would have: a Camera history row, a muted camera, an answered review. Boot 2 is what is
// under test: a fresh process opening that file, exactly what a container restart after the upgrade does.
// Boot 3 proves the upgrade is a no-op the second time.
//
// The new columns are found by DIFFING the schema before and after the rewind, not from a list typed here:
// the rewind drops them by name, but what is checked afterwards is that the upgrade restores the WHOLE fresh
// schema, so a guard testing the wrong column (the column is then never added) fails here.
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
    ['--input-type=module', '-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\n${script}`],
    { encoding: 'utf8' }
  );
}

const ADDED = {
  camera_events: ['actor_user_id', 'actor_username'],
  cameras: ['alerts_snoozed_by'],
  sleep_reviews: ['answered_by_user_id', 'answered_by_username'],
};
const TABLES = Object.keys(ADDED);

const schemaOf = `(t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value }))`;

test('★ C8: an install from before #552 gains the who-did-it columns on boot, keeps its rows, and names nobody on them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-whomig-'));
  try {
    // Boot 1: today's schema, then rewound to before this change, with old rows planted.
    const fresh = JSON.parse(runInFreshProcess(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       const schemaOf = ${schemaOf};
       const fresh = Object.fromEntries(${JSON.stringify(TABLES)}.map((t) => [t, schemaOf(t)]));
       for (const [table, cols] of Object.entries(${JSON.stringify(ADDED)})) {
         for (const col of cols) db.exec('ALTER TABLE ' + table + ' DROP COLUMN ' + col);
       }
       db.prepare("INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES ('old-cam', 'Old Cam', 'restart', 'stream restarted manually')").run();
       db.prepare("INSERT INTO cameras (id, name, rtsp_url, mediamtx_path, alerts_snoozed_until) VALUES ('old-cam', 'Old Cam', 'rtsp://example/s', 'old', 4102444800000)").run();
       db.prepare("INSERT INTO sleep_reviews (child_id, night_date, true_wake_at, note) VALUES ('old-kid', '2026-09-01', '2026-09-01 20:00:00', 'old note')").run();
       console.log(JSON.stringify(fresh));`
    ).trim());
    for (const [table, cols] of Object.entries(ADDED)) {
      for (const col of cols) assert.ok(fresh[table].some((c) => c.name === col), `setup: a fresh install has ${table}.${col}`);
    }

    const readBack = `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       const schemaOf = ${schemaOf};
       console.log(JSON.stringify({
         schema: Object.fromEntries(${JSON.stringify(TABLES)}.map((t) => [t, schemaOf(t)])),
         event: db.prepare("SELECT * FROM camera_events WHERE camera_id = 'old-cam'").get(),
         camera: db.prepare("SELECT alerts_snoozed_until, alerts_snoozed_by FROM cameras WHERE id = 'old-cam'").get(),
         review: db.prepare("SELECT * FROM sleep_reviews WHERE child_id = 'old-kid'").get(),
       }));`;

    for (const boot of [2, 3]) {
      const got = JSON.parse(runInFreshProcess(dir, readBack).trim());
      for (const table of TABLES) {
        const byName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
        assert.deepEqual(byName(got.schema[table]), byName(fresh[table]),
          `boot ${boot}: ${table} is not back to the fresh schema (a guard that tests the wrong column never adds it)`);
      }
      for (const [table, cols] of Object.entries(ADDED)) {
        for (const col of cols) {
          const def = got.schema[table].find((c) => c.name === col);
          assert.deepEqual([def.type, def.notnull, def.dflt], ['TEXT', 0, null], `boot ${boot}: ${table}.${col} is nullable TEXT, no default`);
        }
      }
      assert.equal(got.event.detail, 'stream restarted manually', 'the old history row is kept');
      assert.equal(got.event.actor_user_id, null, 'and names nobody: it could have been a person or the watchdog');
      assert.equal(got.event.actor_username, null);
      assert.deepEqual(got.camera, { alerts_snoozed_until: 4102444800000, alerts_snoozed_by: null },
        'a camera muted before the upgrade stays muted, with no name');
      assert.equal(got.review.true_wake_at, '2026-09-01 20:00:00', 'the old review keeps its answer');
      assert.equal(got.review.note, 'old note');
      assert.equal(got.review.answered_by_user_id, null, 'and is answered by nobody we know');
      assert.equal(got.review.answered_by_username, null);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
